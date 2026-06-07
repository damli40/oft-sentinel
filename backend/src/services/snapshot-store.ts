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
}

function key(oft: string, chainId: number): string {
  return `${chainId}:${oft.toLowerCase()}`;
}

function load(): State {
  if (!existsSync(STATE_FILE)) return { snapshots: {}, verdicts: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { snapshots: {}, verdicts: [] };
  }
}

function save(state: State): void {
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
  const matching = load().verdicts.filter((v) => key(v.oft, v.chainId) === k);
  return matching.length ? matching[matching.length - 1] : null;
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

export function appendScoreHistory(entry: HistoryEntry): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
}

export function getScoreHistory(oft: string, chainId: number, limit = 100): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const k = key(oft, chainId);
  const lines = readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean);
  const all: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as HistoryEntry;
      if (key(e.oft, e.chainId) === k) all.push(e);
    } catch { /* skip malformed */ }
  }
  return all.slice(-limit);
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
