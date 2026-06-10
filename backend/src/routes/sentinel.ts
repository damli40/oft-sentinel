import { Router } from "express";
import type { Request, Response } from "express";
import { getWatched, pollOnce, runKelpReplay, runLibraryRevertReplay, runRpcConflictReplay, resetDemo } from "../services/sentinel.js";
import { getVerdicts, getSnapshot, latestVerdict, getScoreHistory, getFeedEvents } from "../services/snapshot-store.js";
import { assessSnapshot } from "../services/drift.js";
import { generateReport } from "../services/report.js";
import { askCopilot } from "../services/ask.js";
import { loadDvnMeta, resolveDvn } from "../services/lz-config.js";

export const router = Router();

const MANTLE_CHAIN_ID = Number(process.env.MANTLE_CHAIN_ID ?? 5000);

// ── Copilot rate limiting ─────────────────────────────────────────────────────
// IP-based sliding window: 10 questions per hour per IP. Protects the DeepSeek
// budget if the demo gets shared publicly; cached answers still consume a slot
// (the limit is on requests, the cache is on LLM spend).
const ASK_LIMIT = 10;
const ASK_WINDOW_MS = 60 * 60_000;
const ASK_MAX_QUESTION_CHARS = 500;
const askHits = new Map<string, number[]>();

function askRateCheck(ip: string): { ok: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const hits = (askHits.get(ip) ?? []).filter((t) => now - t < ASK_WINDOW_MS);
  if (hits.length >= ASK_LIMIT) {
    askHits.set(ip, hits);
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil((hits[0] + ASK_WINDOW_MS - now) / 1000) };
  }
  hits.push(now);
  askHits.set(ip, hits);
  return { ok: true, remaining: ASK_LIMIT - hits.length, retryAfterSec: 0 };
}

// GET /api/sentinel/report/:address — full markdown audit report for one watched OFT.
router.get("/report/:address", async (req: Request, res: Response) => {
  const addr = String(req.params.address).toLowerCase();
  const w = (await getWatched()).find((x) => x.address.toLowerCase() === addr);
  if (!w) {
    res.status(404).json({ error: "Not a watched OFT" });
    return;
  }
  try {
    const markdown = await generateReport(w);
    if (!markdown) {
      res.status(425).json({ error: "Not polled yet — try again shortly" });
      return;
    }
    res.json({ ticker: w.ticker, markdown });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sentinel/status — watched OFTs + their latest snapshot, current risk
// posture (assessSnapshot on the live snapshot — display only, no on-chain action),
// and their latest drift verdict (the attested one).
router.get("/status", async (_req: Request, res: Response) => {
  const [list, dvnMeta] = await Promise.all([getWatched(), loadDvnMeta()]);
  const watched = await Promise.all(list.map(async (w) => {
    const snap = getSnapshot(w.address, w.chainId);
    const a = snap ? await assessSnapshot(snap, w.ticker) : null;
    // DVN addresses in send config are on the source chain (Mantle) — always resolve with "mantle".
    const srcChainKey = "mantle";
    // Per-corridor DVN breakdown: one entry per active route, null when ULN is unreadable.
    const activeRoutes = snap?.routes.filter(r => r.isActive) ?? [];
    const dvnCorridors = activeRoutes.length > 0
      ? activeRoutes.map(r => {
          if (!r.uln) return { corridor: r.chainName, eid: r.eid, uln: null };
          const names = Object.fromEntries(
            [...r.uln.requiredDVNs, ...r.uln.optionalDVNs].map(addr => [addr, resolveDvn(addr, srcChainKey, dvnMeta)])
          );
          return {
            corridor: r.chainName,
            eid: r.eid,
            uln: {
              requiredCount: r.uln.requiredDVNCount,
              optionalThreshold: r.uln.optionalDVNThreshold,
              effectiveCount: r.uln.requiredDVNCount + (r.uln.optionalDVNThreshold ?? 0),
              requiredDVNs: r.uln.requiredDVNs,
              optionalDVNs: r.uln.optionalDVNs,
              names,
            },
          };
        })
      : null;
    // dvnSummary: first corridor with a readable ULN (for backward-compat summary panels).
    const firstReadable = activeRoutes.find(r => r.uln !== null);
    const firstUln = firstReadable?.uln ?? null;
    const dvnSummary = firstUln ? {
      requiredCount: firstUln.requiredDVNCount,
      optionalThreshold: firstUln.optionalDVNThreshold,
      effectiveCount: firstUln.requiredDVNCount + (firstUln.optionalDVNThreshold ?? 0),
      requiredDVNs: firstUln.requiredDVNs,
      optionalDVNs: firstUln.optionalDVNs,
    } : null;
    const dvnNames = firstUln ? Object.fromEntries(
      [...firstUln.requiredDVNs, ...firstUln.optionalDVNs].map((addr) => [addr, resolveDvn(addr, srcChainKey, dvnMeta)])
    ) : null;
    return {
      ...w,
      lastSnapshotAt: snap?.capturedAt ?? null,
      corridors: activeRoutes.map(r => r.chainName),
      assessment: a ? {
        score: a.score,
        riskLevel: a.riskLevel,
        reasons: a.findings.filter(f => f.severity !== "PASS").map(f => f.detail),
        tis: a.tis,
      } : null,
      latestVerdict: latestVerdict(w.address, w.chainId),
      dvnSummary,
      dvnNames,
      dvnCorridors,
    };
  }));

  // Mantle Security Index: unweighted average of all assessed scores (0–100).
  // DEMO is synthetic (replay-only) — it must never move the fleet index.
  const real = watched.filter((w) => w.ticker !== "DEMO");
  const assessed = real.filter((w) => w.assessment !== null);
  const msi = assessed.length > 0
    ? Math.round(assessed.reduce((s, w) => s + w.assessment!.score, 0) / assessed.length)
    : null;
  const msiBreakdown = {
    critical: real.filter((w) => w.assessment?.riskLevel === "CRITICAL").length,
    atRisk: real.filter((w) => w.assessment?.riskLevel === "AT_RISK").length,
    safe: real.filter((w) => w.assessment?.riskLevel === "PASS").length,
    unassessed: real.length - assessed.length,
  };

  res.json({
    watched,
    msi,
    msiBreakdown,
    registry: process.env.AUDIT_REGISTRY_ADDRESS,
    alertBus: process.env.ALERT_BUS_ADDRESS,
  });
});

// GET /api/sentinel/verdicts — full attestation history.
router.get("/verdicts", (_req: Request, res: Response) => {
  res.json({ verdicts: getVerdicts() });
});

// POST /api/sentinel/poll — run one live poll across all watched OFTs now.
router.post("/poll", async (_req: Request, res: Response) => {
  try {
    await pollOnce();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/replay-kelp — the demo: seed healthy → inject 1-of-1 →
// verdict flips CRITICAL → real attestation on Mantle Sepolia.
router.post("/replay-kelp", async (_req: Request, res: Response) => {
  try {
    const verdict = await runKelpReplay();
    res.json({ ok: true, verdict });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/replay-library-revert — demo: seed healthy (pinned libs) →
// inject snapshot where receive library reverted to default → CRITICAL verdict.
router.post("/replay-library-revert", async (_req: Request, res: Response) => {
  try {
    const verdict = await runLibraryRevertReplay();
    res.json({ ok: true, verdict });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/replay-rpc-conflict — demo: seed healthy baseline →
// inject snapshot where secondary RPC disagrees on DVN config → CRITICAL verdict.
router.post("/replay-rpc-conflict", async (_req: Request, res: Response) => {
  try {
    const verdict = await runRpcConflictReplay();
    res.json({ ok: true, verdict });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sentinel/history/:address — score history for one watched OFT.
router.get("/history/:address", (req: Request, res: Response) => {
  const addr = String(req.params.address).toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const history = getScoreHistory(addr, MANTLE_CHAIN_ID, limit);
  res.json({ oft: addr, history });
});

// GET /api/sentinel/feed — time-ordered security event stream.
router.get("/feed", (_req: Request, res: Response) => {
  const events = getFeedEvents(40);
  res.json({ events });
});

// POST /api/sentinel/ask — Security Copilot: natural language queries over fleet data.
// Rate-limited (10/hour/IP), input-capped (500 chars); answers cached in ask.ts.
router.post("/ask", async (req: Request, res: Response) => {
  const question = req.body?.question as string;
  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  if (question.length > ASK_MAX_QUESTION_CHARS) {
    res.status(400).json({ error: `Question too long (max ${ASK_MAX_QUESTION_CHARS} characters)` });
    return;
  }
  const rate = askRateCheck(req.ip ?? "unknown");
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({
      error: `Community tier limit reached (${ASK_LIMIT} questions/hour). Try again in ${Math.max(1, Math.ceil(rate.retryAfterSec / 60))} min.`,
      retryAfterSec: rate.retryAfterSec,
    });
    return;
  }
  try {
    const result = await askCopilot(question);
    res.json({ ...result, remaining: rate.remaining, limit: ASK_LIMIT });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/reset-demo — re-seed the DEMO OFT's healthy 2-of-2 baseline
// so the before→after of the next replay is visible in the fleet grid.
router.post("/reset-demo", (_req: Request, res: Response) => {
  resetDemo();
  res.json({ ok: true });
});

// GET /api/sentinel/history — score history for every watched OFT in one call
// (fleet-grid sparklines). Keyed by lowercase address.
router.get("/history", async (_req: Request, res: Response) => {
  const watched = await getWatched();
  const histories = Object.fromEntries(
    watched.map((w) => [w.address.toLowerCase(), getScoreHistory(w.address, MANTLE_CHAIN_ID, 60)])
  );
  res.json({ histories });
});
