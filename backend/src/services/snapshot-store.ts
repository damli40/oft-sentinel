import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { OftSnapshot, SentinelVerdict } from "../types.js";

// DATA_DIR can be overridden via env var — set to /data on Railway (persistent volume).
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const STATE_FILE = join(DATA_DIR, "sentinel-state.json");
const HISTORY_FILE = join(DATA_DIR, "score-history.jsonl");

interface State {
  snapshots: Record<string, OftSnapshot>; // key → last-known-good snapshot
  verdicts: SentinelVerdict[]; // newest last
  // key → timestamp: verdicts captured at/before this moment are hidden from
  // latestVerdict() (tile/overlay) but stay in the ledger — the on-chain
  // attestations are immutable. Set by "Reset demo".
  verdictsClearedAt?: Record<string, number>;
}

let memState: State | null = null;

function key(oft: string, chainId: number): string {
  return `${chainId}:${oft.toLowerCase()}`;
}

function load(): State {
  if (memState) return memState;
  if (!existsSync(STATE_FILE)) {
    memState = { snapshots: {}, verdicts: [] };
    return memState;
  }
  try {
    memState = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    return memState;
  } catch {
    memState = { snapshots: {}, verdicts: [] };
    return memState;
  }
}

function save(state: State): void {
  memState = state;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getSnapshot(oft: string, chainId: number): OftSnapshot | null {
  return load().snapshots[key(oft, chainId)] ?? null;
}

export function putSnapshot(snap: OftSnapshot): void {
  const state = load();
  state.snapshots[key(snap.oft, snap.chainId)] = snap;
  save(state);
}

export function recordVerdict(v: SentinelVerdict): void {
  const state = load();
  state.verdicts.push(v);
  save(state);
}

export function getVerdicts(): SentinelVerdict[] {
  return load().verdicts;
}

export function latestVerdict(oft: string, chainId: number): SentinelVerdict | null {
  const k = key(oft, chainId);
  const state = load();
  const clearedAt = state.verdictsClearedAt?.[k] ?? 0;
  const matching = state.verdicts.filter((v) => key(v.oft, v.chainId) === k && v.capturedAt > clearedAt);
  return matching.length ? matching[matching.length - 1] : null;
}

/** Hide an OFT's existing verdicts from latestVerdict() without touching the
 * ledger. Used by "Reset demo" so the tile/overlay return to the standing
 * assessment while the attestation history (and on-chain txs) stay intact. */
export function hideVerdictsBefore(oft: string, chainId: number, ts = Date.now()): void {
  const state = load();
  state.verdictsClearedAt = { ...state.verdictsClearedAt, [key(oft, chainId)]: ts };
  save(state);
}

// ── Score history ─────────────────────────────────────────────────────────────
// Append-only JSONL: one line per poll per OFT.

export interface HistoryEntry {
  oft: string;
  chainId: number;
  score: number;
  riskLevel: string;
  capturedAt: number;
}

let histIndex: Map<string, HistoryEntry[]> | null = null;

function loadHistIndex(): Map<string, HistoryEntry[]> {
  if (histIndex) return histIndex;
  histIndex = new Map();
  if (!existsSync(HISTORY_FILE)) return histIndex;
  for (const line of readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(line) as HistoryEntry;
      const k = key(e.oft, e.chainId);
      if (!histIndex.has(k)) histIndex.set(k, []);
      histIndex.get(k)!.push(e);
    } catch { /* skip malformed */ }
  }
  return histIndex;
}

export function appendScoreHistory(entry: HistoryEntry): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
  const idx = loadHistIndex();
  const k = key(entry.oft, entry.chainId);
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k)!.push(entry);
}

export function getScoreHistory(oft: string, chainId: number, limit = 100): HistoryEntry[] {
  const entries = loadHistIndex().get(key(oft, chainId)) ?? [];
  return entries.slice(-limit);
}

// ── Feed events ───────────────────────────────────────────────────────────────
// Derive a time-ordered feed from stored verdicts.

export interface FeedEvent {
  type: "drift" | "attest" | "poll";
  ticker: string;
  detail: string;
  timestamp: number;
  score?: number;
  riskLevel?: string;
  txHash?: string;
}

export function getFeedEvents(limit = 40): FeedEvent[] {
  const verdicts = getVerdicts();
  const events: FeedEvent[] = verdicts.map((v) => ({
    type: v.attestTxHash ? "attest" : "drift",
    ticker: v.ticker,
    detail: v.reasons.slice(0, 2).join("; ") || v.verdict,
    timestamp: v.capturedAt,
    score: v.score,
    riskLevel: v.riskLevel,
    txHash: v.attestTxHash,
  }));
  return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}
