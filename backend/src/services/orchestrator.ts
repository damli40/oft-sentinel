import type { OftSnapshot, WatchedOft, SentinelVerdict, Finding, RiskLevel, TransactionIntent, PolicyDecisionRecord } from "../types.js";
import { detectDrift, assessSnapshot, RULES_VERSION } from "./drift.js";
import { verdictHash, attest } from "./attestor.js";
import { dispatchAlert } from "./alerts.js";
import { getSnapshot, putSnapshot, recordVerdict, getWeakAlertFingerprint, putWeakAlertFingerprint } from "./snapshot-store.js";
import { loadDvnMeta, dvnMetaHash } from "./lz-config.js";

/** Async because the PDR now pins the DVN table that decided the findings. loadDvnMeta()
 *  is cached in-memory for 24h, so this is a map lookup on every call after the first. */
async function buildPdr(
  oft: string,
  chainId: number,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
  evaluatedAt: number,
): Promise<PolicyDecisionRecord> {
  const meta = await loadDvnMeta();
  return {
    oft, chainId, findings, score, riskLevel, evaluatedAt,
    agentId: Number(process.env.SENTINEL_AGENT_ID ?? 1),
    rulesVersion: RULES_VERSION,
    dvnMetaHash: dvnMetaHash(meta),
    dvnMetaFetchedAt: meta.fetchedAt,
  };
}

// Identity of a weak-config alert: the findings that would be disclosed, not the
// moment they were computed. The full verdictHash can't dedupe here — the PDR pins
// evaluatedAt, so every cycle would look "new". Excluding timestamps makes the
// fingerprint stable across polls AND restarts, while any material change (finding
// set, score, risk, rules version) re-fires.
function weakConfigFingerprint(findings: Finding[], score: number, riskLevel: RiskLevel): string {
  return verdictHash({ kind: "weak-config", findings, score, riskLevel, rulesVersion: RULES_VERSION });
}

/**
 * Full alert pipeline for a persistently CRITICAL config that hasn't drifted:
 * attests to AuditRegistry, fires AlertBus (with OFT address + tx links in Telegram),
 * then stores the fingerprint (persisted, keyed chainId:address) so neither later
 * cycles nor a backend restart re-fires it while the findings are unchanged.
 */
export async function produceWeakConfigAttestation(
  watched: WatchedOft,
  snapshot: OftSnapshot,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
  tis: TransactionIntent[],
): Promise<void> {
  const fingerprint = weakConfigFingerprint(findings, score, riskLevel);
  if (getWeakAlertFingerprint(watched.address, watched.chainId) === fingerprint) return;

  const reasons = findings.filter(f => f.severity !== "PASS").map(f => f.detail);
  const pdr = await buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
  const hash = verdictHash(pdr);

  const verdict: SentinelVerdict = {
    oft: snapshot.oft,
    chainId: watched.chainId,
    ticker: watched.ticker,
    score,
    riskLevel,
    verdict: `Persistent CRITICAL config — pre-existing risk, no drift (score ${score}/100)`,
    reasons,
    verdictHash: hash,
    capturedAt: snapshot.capturedAt,
    tis,
    pdr,
  };

  try {
    const { txHash, attestationId } = await attest(snapshot.oft, watched.chainId, hash, score, riskLevel);
    verdict.attestTxHash = txHash;
    verdict.attestationId = attestationId;
    console.log(`[sentinel] weak-config attest ${watched.ticker} score=${score} (id ${attestationId}) — ${txHash}`);
  } catch (e: any) {
    console.error(`[sentinel] weak-config attest failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }

  try {
    verdict.alertTxHash = await dispatchAlert(verdict, snapshot.owner ?? null);
  } catch (e: any) {
    console.error(`[sentinel] weak-config alert failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }
  recordVerdict(verdict);
  putWeakAlertFingerprint(watched.address, watched.chainId, fingerprint);
}

function synthVerdict(reasons: string[], score: number, riskLevel: string): string {
  if (reasons.length === 0) return `Config assessed ${riskLevel} (score ${score}/100).`;
  return `Config drifted into ${riskLevel} (score ${score}/100): ${reasons[0]}.`;
}

/**
 * The deep-audit pipeline for a single snapshot: deterministic assessment →
 * on-chain attestation → tiered alert → persisted verdict. Score and risk are
 * derived from the snapshot (no LLM in the critical path), so the verdict that
 * gets attested is exactly the config that triggered it.
 */
export async function produceVerdict(
  watched: WatchedOft,
  snapshot: OftSnapshot,
  driftReasons: string[]
): Promise<SentinelVerdict> {
  const { score, riskLevel, findings, tis } = await assessSnapshot(snapshot, watched.ticker);
  const reasons = driftReasons.length ? driftReasons : findings.map((f) => `${f.check}: ${f.detail}`);

  const pdr = await buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
  const hash = verdictHash(pdr);

  const verdict: SentinelVerdict = {
    oft: snapshot.oft,
    chainId: watched.chainId,
    ticker: watched.ticker,
    score,
    riskLevel,
    verdict: synthVerdict(reasons, score, riskLevel),
    reasons,
    verdictHash: hash,
    capturedAt: snapshot.capturedAt,
    tis,
    pdr,
  };

  try {
    const { txHash, attestationId } = await attest(snapshot.oft, watched.chainId, hash, score, riskLevel);
    verdict.attestTxHash = txHash;
    verdict.attestationId = attestationId;
    console.log(`[sentinel] attested ${watched.ticker} ${riskLevel} (id ${attestationId}) — ${txHash}`);
  } catch (e: any) {
    console.error(`[sentinel] attest failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }

  try {
    verdict.alertTxHash = await dispatchAlert(verdict, snapshot.owner);
  } catch (e: any) {
    console.error(`[sentinel] alert failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }
  recordVerdict(verdict);
  return verdict;
}

/**
 * One Sentinel check step against an observed snapshot (live OR injected).
 * Compares to the stored baseline; on drift, runs the deep-audit pipeline and
 * advances the baseline. First sighting just stores the baseline.
 */
export async function runCheck(
  watched: WatchedOft,
  observed: OftSnapshot
): Promise<SentinelVerdict | null> {
  const baseline = getSnapshot(observed.oft, observed.chainId);

  if (!baseline) {
    putSnapshot(observed);
    console.log(`[sentinel] baseline captured for ${watched.ticker} (${observed.oft})`);
    return null;
  }

  const drift = await detectDrift(baseline, observed);
  if (!drift.drifted) {
    putSnapshot(observed); // advance timestamp; config unchanged in security-relevant ways
    return null;
  }

  console.log(`[sentinel] DRIFT on ${watched.ticker}: ${drift.reasons.join("; ")}`);
  const verdict = await produceVerdict(watched, observed, drift.reasons);
  putSnapshot(observed); // new state becomes the baseline so we don't re-fire every poll
  return verdict;
}
