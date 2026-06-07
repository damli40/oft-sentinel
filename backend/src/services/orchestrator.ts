import type { OftSnapshot, WatchedOft, SentinelVerdict } from "../types.js";
import { detectDrift, assessSnapshot } from "./drift.js";
import { verdictHash, attest } from "./attestor.js";
import { dispatchAlert } from "./alerts.js";
import { getSnapshot, putSnapshot, recordVerdict } from "./snapshot-store.js";

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
  const { score, riskLevel, findings } = await assessSnapshot(snapshot, watched.ticker);
  const reasons = driftReasons.length ? driftReasons : findings.map((f) => `${f.check}: ${f.detail}`);

  const report = { watched, snapshot, findings, score, riskLevel, reasons, ts: Date.now() };
  const hash = verdictHash(report);

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
  };

  try {
    const { txHash, attestationId } = await attest(snapshot.oft, watched.chainId, hash, score, riskLevel);
    verdict.attestTxHash = txHash;
    verdict.attestationId = attestationId;
    console.log(`[sentinel] attested ${watched.ticker} ${riskLevel} (id ${attestationId}) — ${txHash}`);
  } catch (e: any) {
    console.error(`[sentinel] attest failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }

  verdict.alertTxHash = await dispatchAlert(verdict, snapshot.owner);
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
