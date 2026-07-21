import { Router } from "express";
import type { Request, Response } from "express";
import { getWatched, getWatchlistHealth, pollOnce, runKelpReplay, runLibraryRevertReplay, runRpcConflictReplay, resetDemo } from "../services/sentinel.js";
import { getVerdicts, getSnapshot, latestVerdict, getScoreHistory, getFeedEvents } from "../services/snapshot-store.js";
import { assessSnapshot, RULES_VERSION } from "../services/drift.js";
import { generateReport } from "../services/report.js";
import { askCopilot } from "../services/ask.js";
import { loadDvnMeta, resolveDvn, dvnMetaHash, MetadataUnavailableError, type DvnMeta } from "../services/lz-config.js";
import { getChainRef, chainDisplayName } from "../services/chain-registry.js";
import type { CustodyDeclaration, OftSnapshot } from "../types.js";

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
  // A metadata blackout must not blank the dashboard. A 503 renders as "site broken",
  // which reads to an operator as a deploy problem rather than "monitoring has stopped" —
  // and stale tiles with no marker read as "everything is fine", which is the same class
  // of bug (absence displayed as safety) that the per-chain dead-DVN fix exists to kill.
  // Serve the tiles, stamp the response, let the UI grey them out.
  let dvnMeta: DvnMeta;
  let list: Awaited<ReturnType<typeof getWatched>>;
  try {
    [list, dvnMeta] = await Promise.all([getWatched(), loadDvnMeta()]);
  } catch (e) {
    if (e instanceof MetadataUnavailableError) {
      return res.status(200).json({
        watched: [], chains: [], msi: null,
        msiBreakdown: { critical: 0, atRisk: 0, safe: 0, unassessed: 0 },
        registry: process.env.AUDIT_REGISTRY_ADDRESS,
        alertBus: process.env.ALERT_BUS_ADDRESS,
        rulesVersion: RULES_VERSION,
        degraded: { reason: "dvn_metadata_unavailable", detail: e.message, since: Date.now() },
      });
    }
    throw e;
  }
  const watched = await Promise.all(list.map(async (w) => {
    const snap = getSnapshot(w.address, w.chainId);
    const a = snap ? await assessSnapshot(snap, w.ticker) : null;
    // A DVN's identity is the (chainKey, address) pair. Send-side DVNs live on the OFT's
    // OWN chain — resolving them against a hardcoded "mantle" gave every Ethereum and Base
    // asset the wrong DVN names (same bug drift.ts fixed in rules 2.1.0). Unknown chain →
    // resolveDvn returns an address fragment, never a name borrowed from another chain.
    const srcChainKey = getChainRef(w.chainId)?.chainKey ?? null;
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

  // Distinct chains actually watched, biggest fleet first. This is THE source the
  // frontend renders chain names, fleet tabs, and hero/footer copy from — adding a
  // chain to the registry + watchlist updates the whole UI with zero frontend edits.
  const chainCounts = new Map<number, number>();
  for (const w of watched) chainCounts.set(w.chainId, (chainCounts.get(w.chainId) ?? 0) + 1);
  const chains = [...chainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chainId, count]) => {
      const key = getChainRef(chainId)?.chainKey ?? null;
      return { chainId, chainKey: key, name: key ? chainDisplayName(key) : `Chain ${chainId}`, count };
    });

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

  // Metadata provenance, mirrored from the PDR. `stale` when we are serving a cached DVN
  // table because the live fetch failed — verdicts are still real, just computed against
  // an older ground truth. The hash lets a reader confirm which one.
  const metaAgeMs = Date.now() - dvnMeta.fetchedAt;
  res.json({
    watched,
    chains,
    msi,
    msiBreakdown,
    registry: process.env.AUDIT_REGISTRY_ADDRESS,
    alertBus: process.env.ALERT_BUS_ADDRESS,
    rulesVersion: RULES_VERSION,
    dvnMeta: {
      hash: dvnMetaHash(dvnMeta),
      fetchedAt: dvnMeta.fetchedAt,
      stale: metaAgeMs > 24 * 3600_000,
    },
    // Watchlist provenance, same contract as dvnMeta: tiles keep rendering during a
    // Dune outage, but the response says the fleet list is degraded/stale so the UI
    // can mark reduced coverage instead of displaying absence as safety.
    watchlist: getWatchlistHealth(),
  });
});

// GET /api/sentinel/verdicts — full attestation history.
router.get("/verdicts", (_req: Request, res: Response) => {
  res.json({ verdicts: getVerdicts() });
});

// ── POST /api/sentinel/validate — the rule engine as a PURE function ────────
// Pre-flight check for proposed or existing configs (the MCP validate_config
// tool rides this). Runs assessSnapshot on the submitted snapshot ONLY: no
// attestation, no alert, no snapshot/verdict storage — same request, same
// response, regardless of server state. Custody comes from the request or is
// explicitly none; the operator's declarations store is never consulted, so a
// public caller can't inherit declarations for an address they don't control.
const VALIDATE_MAX_ROUTES = 30;
const VALIDATE_CUSTODY_TYPES = new Set(["eoa_hot", "fireblocks_mpc", "safe_multisig", "unknown"]);
const VALIDATE_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── x402 challenge (OKX Agent Payments Protocol) ─────────────────────────────
// OKX's escrow probes this endpoint expecting an HTTP 402 challenge even at
// fee 0 — without one it falls back to direct-accept and the task dies waiting
// for a result that x402 would have taken from the HTTP response itself. The
// challenge advertises the listed terms of agent #6455: 0 USDT on X Layer.
// Requests carrying an x402 payment header, or any request with a snapshot
// body, still get the verdict; only unpaid snapshot-less requests see the 402.
const X402_RESOURCE_URL =
  process.env.PUBLIC_VALIDATE_URL ?? "https://backend-production-d16e.up.railway.app/api/sentinel/validate";
const X402_CHALLENGE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: X402_RESOURCE_URL,
      description: "OFT Config Validation — deterministic LayerZero OFT verdict with findings",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:196",
        asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT (USD₮0) on X Layer
        // OKX's x402-check can't resolve this asset's decimals from its own
        // token list and asks for a `decimals` field in the accepts entry.
        decimals: 6,
        amount: "0",
        payTo: "0xd2e640e2ff4d9693f1c8000bbcc10a8de76c0e7d", // agent #6455 owner wallet
        maxTimeoutSeconds: 60,
        extra: { assetSymbol: "USDT", assetDecimals: 6, assetTransferMethod: "eip3009", name: "USD₮0", version: "1" },
      },
    ],
  }),
).toString("base64");

function sendX402Challenge(res: Response): void {
  res.status(402).set("PAYMENT-REQUIRED", X402_CHALLENGE).json({
    error: "Payment required",
    hint: "POST { snapshot, ticker?, custodyDeclaration? } — a valid snapshot body or an x402 payment header unlocks the verdict",
  });
}

// GET /api/sentinel/validate — x402 discovery probe (OKX checks GET first).
router.get("/validate", (_req: Request, res: Response) => sendX402Challenge(res));

router.post("/validate", async (req: Request, res: Response) => {
  const bad = (error: string) => res.status(400).json({ error });
  const body = req.body as Record<string, unknown> | undefined;
  const s = body?.snapshot as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") {
    // Snapshot-less and unpaid = an x402 probe, not a malformed API call.
    if (!req.headers["payment-signature"] && !req.headers["x-payment"]) {
      sendX402Challenge(res);
      return;
    }
    bad("body must be { snapshot, ticker?, custodyDeclaration? }");
    return;
  }
  if (typeof s.oft !== "string" || !VALIDATE_ADDR_RE.test(s.oft)) {
    bad("snapshot.oft must be a 0x-prefixed 40-hex address");
    return;
  }
  if (typeof s.chainId !== "number" || !Number.isInteger(s.chainId)) {
    bad("snapshot.chainId must be an integer chain id");
    return;
  }
  if (!Array.isArray(s.routes)) {
    bad("snapshot.routes must be an array");
    return;
  }
  if (s.routes.length > VALIDATE_MAX_ROUTES) {
    bad(`too many routes (${s.routes.length}) — max ${VALIDATE_MAX_ROUTES} per validation`);
    return;
  }
  for (const r of s.routes) {
    if (!r || typeof r !== "object" || typeof (r as Record<string, unknown>).eid !== "number") {
      bad("every route needs at least a numeric eid");
      return;
    }
  }
  let custody: CustodyDeclaration | null = null;
  const cd = body?.custodyDeclaration as Record<string, unknown> | undefined;
  if (cd !== undefined) {
    if (!cd || typeof cd !== "object" || !VALIDATE_CUSTODY_TYPES.has(String(cd.custodyType)) || typeof cd.declaredBy !== "string") {
      bad(`custodyDeclaration must be { custodyType: ${[...VALIDATE_CUSTODY_TYPES].join(" | ")}, declaredBy }`);
      return;
    }
    custody = {
      custodyType: cd.custodyType as CustodyDeclaration["custodyType"],
      declaredBy: cd.declaredBy,
      declaredAt: typeof cd.declaredAt === "string" ? cd.declaredAt : new Date().toISOString().slice(0, 10),
      verified: false,
    };
  }
  // Missing optional fields become null — the engine already treats null as
  // "unknown, never scored", so a partial agent-built config validates on
  // exactly what it asserts.
  const routeDefaults = {
    chainKey: null, sendLibrary: null, sendLibIsDefault: null, receiveLibrary: null,
    receiveLibIsDefault: null, uln: null, receiveUln: null, peer: null, peerAddress: null,
    hasEnforcedOptions: null, isActive: true,
  };
  const snapshot = {
    owner: null, ownerIsContract: null, proxyAdmin: null, proxyAdminOwner: null,
    proxyAdminIsMultisig: null, proxyAdminOwnerIsContract: null,
    ...s,
    capturedAt: typeof s.capturedAt === "number" ? s.capturedAt : Date.now(),
    routes: (s.routes as Array<Record<string, unknown>>).map((r) => ({
      ...routeDefaults,
      ...r,
      chainName: typeof r.chainName === "string" && r.chainName !== "" ? r.chainName : `eid-${r.eid}`,
    })),
  } as unknown as OftSnapshot;
  try {
    const { findings, score, riskLevel, tis } = await assessSnapshot(
      snapshot,
      typeof body?.ticker === "string" ? body.ticker : undefined,
      custody,
    );
    res.json({ score, riskLevel, findings, tis, rulesVersion: RULES_VERSION });
  } catch (e: any) {
    if (e instanceof MetadataUnavailableError) {
      res.status(503).json({ error: "DVN metadata unavailable — try again shortly" });
      return;
    }
    res.status(500).json({ error: e.message });
  }
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
