import type { OftSnapshot, WatchedOft, SentinelVerdict, Finding, RiskLevel } from "../types.js";
import { detectDrift, assessSnapshot } from "./drift.js";
import { verdictHash, attest } from "./attestor.js";
import { dispatchAlert, sendTelegram } from "./alerts.js";
import { getSnapshot, putSnapshot, recordVerdict } from "./snapshot-store.js";

// Per-OFT cooldown for weak-config Telegram alerts (1 hour). Attest fires every poll.
const weakAlertCooldown = new Map<string, number>();
const WEAK_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function aiWeakConfigRec(ticker: string, findings: Finding[]): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return "";
  const top = findings
    .filter(f => f.severity === "CRITICAL" || f.severity === "HIGH")
    .slice(0, 2)
    .map(f => `${f.severity}: ${f.detail}`)
    .join("\n");
  if (!top) return "";
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 120,
        messages: [
          { role: "system", content: "You are a LayerZero security advisor. Reply in exactly 2 sentences: first what to fix, then why it matters. No preamble." },
          { role: "user", content: `${ticker} OFT has these findings:\n${top}\nWhat should the team fix first?` },
        ],
      }),
    });
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Attests the current (non-drifted) weak config on-chain on every poll,
 * and sends a Telegram alert with an AI recommendation once per hour.
 */
export async function produceWeakConfigAttestation(
  watched: WatchedOft,
  snapshot: OftSnapshot,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
): Promise<void> {
  const reasons = findings.map(f => `${f.check}: ${f.detail}`);
  const report = { watched, snapshot, findings, score, riskLevel, reasons, ts: Date.now() };
  const hash = verdictHash(report);

  // Attest on-chain every poll (continuous on-chain proof of persistent risk).
  try {
    const { txHash, attestationId } = await attest(snapshot.oft, watched.chainId, hash, score, riskLevel);
    console.log(`[sentinel] weak-config attest ${watched.ticker} score=${score} (id ${attestationId}) — ${txHash}`);
  } catch (e: any) {
    console.error(`[sentinel] weak-config attest failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }

  // Telegram alert: throttled to once per hour.
  const lastSent = weakAlertCooldown.get(watched.address) ?? 0;
  if (Date.now() - lastSent < WEAK_ALERT_COOLDOWN_MS) return;

  const rec = await aiWeakConfigRec(watched.ticker, findings);
  const publicChatId = process.env.TELEGRAM_PUBLIC_ALERT_CHAT_ID ?? process.env.TELEGRAM_ALERT_CHAT_ID ?? null;
  const topFinding = findings[0];
  const msg = [
    `⚠️ ${watched.ticker} weak config (score ${score}/100 · ${riskLevel})`,
    topFinding ? `Top risk: ${topFinding.detail}` : "",
    rec ? `🤖 Fix: ${rec}` : "",
  ].filter(Boolean).join("\n");

  await sendTelegram(publicChatId, msg, `weak:${watched.ticker}`);
  weakAlertCooldown.set(watched.address, Date.now());
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
