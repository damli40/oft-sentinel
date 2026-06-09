import { Router } from "express";
import type { Request, Response } from "express";
import { getWatched, pollOnce, runKelpReplay, runLibraryRevertReplay, runRpcConflictReplay } from "../services/sentinel.js";
import { getVerdicts, getSnapshot, latestVerdict, getScoreHistory, getFeedEvents } from "../services/snapshot-store.js";
import { assessSnapshot } from "../services/drift.js";
import { generateReport } from "../services/report.js";
import { askCopilot } from "../services/ask.js";
import { loadDvnMeta, resolveDvn } from "../services/lz-config.js";

export const router = Router();

const MANTLE_CHAIN_ID = Number(process.env.MANTLE_CHAIN_ID ?? 5000);

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
    const firstUln = snap?.routes[0]?.uln;
    // DVN addresses in send config are on the source chain (Mantle) — always resolve with "mantle".
    const srcChainKey = "mantle";
    return {
      ...w,
      lastSnapshotAt: snap?.capturedAt ?? null,
      corridors: snap?.routes.filter(r => r.isActive).map(r => r.chainName) ?? [],
      assessment: a ? {
        score: a.score,
        riskLevel: a.riskLevel,
        reasons: a.findings.filter(f => f.severity !== "PASS").map(f => f.detail),
        tis: a.tis,
      } : null,
      latestVerdict: latestVerdict(w.address, w.chainId),
      dvnSummary: firstUln ? {
        requiredCount: firstUln.requiredDVNCount,
        optionalThreshold: firstUln.optionalDVNThreshold,
        effectiveCount: firstUln.requiredDVNCount + (firstUln.optionalDVNThreshold ?? 0),
        requiredDVNs: firstUln.requiredDVNs,
        optionalDVNs: firstUln.optionalDVNs,
      } : null,
      dvnNames: firstUln ? Object.fromEntries(
        [...firstUln.requiredDVNs, ...firstUln.optionalDVNs].map((a) => [a, resolveDvn(a, srcChainKey, dvnMeta)])
      ) : null,
    };
  }));

  // Mantle Security Index: unweighted average of all assessed scores (0–100).
  const assessed = watched.filter((w) => w.assessment !== null);
  const msi = assessed.length > 0
    ? Math.round(assessed.reduce((s, w) => s + w.assessment!.score, 0) / assessed.length)
    : null;
  const msiBreakdown = {
    critical: watched.filter((w) => w.assessment?.riskLevel === "CRITICAL").length,
    atRisk: watched.filter((w) => w.assessment?.riskLevel === "AT_RISK").length,
    safe: watched.filter((w) => w.assessment?.riskLevel === "PASS").length,
    unassessed: watched.length - assessed.length,
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
router.post("/ask", async (req: Request, res: Response) => {
  const question = req.body?.question as string;
  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  try {
    const result = await askCopilot(question);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
