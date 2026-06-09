import type { OftSnapshot, WatchedOft, SentinelVerdict, Finding, RiskLevel, TransactionIntent, PolicyDecisionRecord } from "../types.js";
import { detectDrift, assessSnapshot } from "./drift.js";
import { verdictHash, attest } from "./attestor.js";
import { dispatchAlert } from "./alerts.js";
import { getSnapshot, putSnapshot, recordVerdict } from "./snapshot-store.js";

const RULES_VERSION = "1.0.0";

function buildPdr(
  oft: string,
  chainId: number,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
  evaluatedAt: number,
): PolicyDecisionRecord {
  return { oft, chainId, findings, score, riskLevel, evaluatedAt, agentId: Number(process.env.SENTINEL_AGENT_ID ?? 1), rulesVersion: RULES_VERSION };
}

// Per-boot set: once an OFT's weak-config alert fires this session it won't re-fire
// until the backend restarts. Cleared automatically on process exit.
const weakAlertFired = new Set<string>();

/**
 * Full alert pipeline for a persistently CRITICAL config that hasn't drifted:
 * attests to AuditRegistry, fires AlertBus (with OFT address + tx links in Telegram),
 * then marks the OFT so it won't re-fire this boot.
 */
export async function produceWeakConfigAttestation(
  watched: WatchedOft,
  snapshot: OftSnapshot,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
  tis: TransactionIntent[],
): Promise<void> {
  if (weakAlertFired.has(watched.address)) return;

  const reasons = findings.filter(f => f.severity !== "PASS").map(f => f.detail);
  const pdr = buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
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
  weakAlertFired.add(watched.address);
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

  const pdr = buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
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
