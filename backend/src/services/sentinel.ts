import type { OftSnapshot, RouteSnapshot, WatchedOft, SentinelVerdict } from "../types.js";
import { readSnapshot } from "./lz-config.js";
import { assessSnapshot } from "./drift.js";
import { runCheck } from "./orchestrator.js";
import { putSnapshot, appendScoreHistory } from "./snapshot-store.js";
import { getSentinelWatchlist } from "./dune.js";

const MANTLE_RPC = process.env.MANTLE_RPC ?? "https://rpc.mantle.xyz";
const MANTLE_CHAIN_ID = Number(process.env.MANTLE_CHAIN_ID ?? 5000);
const POLL_CONCURRENCY = 6; // OFTs read in parallel per cycle (bounds RPC load)

// Watchlist: OFTs with 10+ messages in the past 7 days from the sentinel Dune query.
// Dormant and test contracts are excluded before they reach the polling loop.
let watchedCache: { at: number; list: WatchedOft[] } | null = null;
const WATCHED_TTL = 10 * 60_000;

export async function getWatched(force = false): Promise<WatchedOft[]> {
  if (!force && watchedCache && Date.now() - watchedCache.at < WATCHED_TTL) return watchedCache.list;
  const ofts = await getSentinelWatchlist(force).catch(() => []);
  const list = ofts
    .filter((o) => o.address && /^0x[0-9a-fA-F]{40}$/.test(o.address))
    .map((o) => ({ ticker: o.ticker, address: o.address as string, chainId: MANTLE_CHAIN_ID }));
  if (list.length) watchedCache = { at: Date.now(), list };
  return list;
}

async function findWatched(ticker: string): Promise<WatchedOft | undefined> {
  const list = await getWatched();
  return list.find((w) => w.ticker.toLowerCase() === ticker.toLowerCase());
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

let polling = false;

/** Poll every watched OFT once: read live config → run the drift check. */
export async function pollOnce(): Promise<void> {
  if (polling) {
    console.log("[sentinel] poll already in progress — skipping this tick");
    return;
  }
  polling = true;
  try {
    const watched = await getWatched();
    console.log(`[sentinel] polling ${watched.length} OFTs on Mantle (${MANTLE_CHAIN_ID})`);
    await mapLimit(watched, POLL_CONCURRENCY, async (w) => {
      try {
        const snap = await readSnapshot(w.address, w.chainId, MANTLE_RPC);
        // Record score history on every poll cycle.
        const { score, riskLevel } = await assessSnapshot(snap, w.ticker);
        appendScoreHistory({ oft: w.address, chainId: w.chainId, score, riskLevel, capturedAt: snap.capturedAt });
        await runCheck(w, snap);
      } catch (e: any) {
        console.error(`[sentinel] poll failed for ${w.ticker}:`, e.shortMessage ?? e.message);
      }
    });
  } finally {
    polling = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSentinel(intervalMs = 5 * 60_000): void {
  console.log(`[sentinel] starting fleet poll on Mantle (${MANTLE_CHAIN_ID}), every ${intervalMs / 1000}s`);
  pollOnce().catch(console.error);
  timer = setInterval(() => pollOnce().catch(console.error), intervalMs);
}

export function stopSentinel(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Demo: Kelp replay ───────────────────────────────────────────────────────
// rsETH was drained because a route ran on a single DVN (1-of-1). We can't alter
// a live mainnet config, so the replay seeds a healthy 2-of-2 baseline, then
// feeds the loop a crafted 1-of-1 snapshot to show the verdict flip to CRITICAL
// and a real attestation land on Mantle.

function route(eid: number, chainName: string, requiredDVNCount: number, confirmations: number): RouteSnapshot {
  const dvns = ["0x589dEDbD617e0CBcB916A9223F4d1300c294236b", "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24"];
  return {
    eid,
    chainName,
    chainKey: "ethereum",
    sendLibrary: "0x1234567890123456789012345678901234567890",
    sendLibIsDefault: false,
    receiveLibrary: "0x1234567890123456789012345678901234567890",
    receiveLibIsDefault: false,
    uln: {
      confirmations,
      requiredDVNCount,
      requiredDVNs: dvns.slice(0, requiredDVNCount),
      optionalDVNCount: 0,
      optionalDVNThreshold: 0,
      optionalDVNs: [],
    },
    receiveUln: null, // synthetic — no destination-side read in the replay
    peer: "0x000000000000000000000000" + "ab".repeat(20),
    peerAddress: "0x" + "ab".repeat(20),
    hasEnforcedOptions: null,
    isActive: true,
  };
}

function makeSnapshot(oft: string, chainId: number, requiredDVNCount: number): OftSnapshot {
  return {
    oft,
    chainId,
    capturedAt: Date.now(),
    owner: "0x000000000000000000000000000000000000dEaD",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    routes: [route(30101, "ethereum", requiredDVNCount, 15)],
  };
}

export async function runKelpReplay(ticker = "cmETH"): Promise<SentinelVerdict> {
  const w = await findWatched(ticker);
  if (!w) throw new Error(`Unknown watched OFT: ${ticker}`);

  // 1. Seed a healthy 2-of-2 baseline.
  putSnapshot(makeSnapshot(w.address, w.chainId, 2));

  // 2. Feed the crafted 1-of-1 drift through the live loop logic.
  const drifted = makeSnapshot(w.address, w.chainId, 1);
  const verdict = await runCheck(w, drifted);
  if (!verdict) throw new Error("Kelp replay did not trigger drift — check baseline seeding");
  return verdict;
}

// ── Demo: Library revert replay ─────────────────────────────────────────────
// Replays the "receive library reverted to default" attack pattern:
// LZ Labs can change inbound message acceptance rules unilaterally,
// bypassing DVN config entirely. Drifts a pinned-library baseline to
// CRITICAL and lands a real attestation on Mantle Sepolia.

function routeLibRevert(eid: number, chainName: string): RouteSnapshot {
  return { ...route(eid, chainName, 2, 15), receiveLibIsDefault: true };
}

function makeSnapshotLibRevert(oft: string, chainId: number): OftSnapshot {
  return {
    oft,
    chainId,
    capturedAt: Date.now(),
    owner: "0x000000000000000000000000000000000000dEaD",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    routes: [routeLibRevert(30101, "ethereum")],
  };
}

export async function runLibraryRevertReplay(ticker = "cmETH"): Promise<SentinelVerdict> {
  const w = await findWatched(ticker);
  if (!w) throw new Error(`Unknown watched OFT: ${ticker}`);

  // 1. Seed a healthy baseline (both libraries pinned).
  putSnapshot(makeSnapshot(w.address, w.chainId, 2));

  // 2. Feed a snapshot where receive library reverted to default — CRITICAL.
  const drifted = makeSnapshotLibRevert(w.address, w.chainId);
  const verdict = await runCheck(w, drifted);
  if (!verdict) throw new Error("Library revert replay did not trigger drift — check baseline seeding");
  return verdict;
}
