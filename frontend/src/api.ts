const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api";

export interface MantleOft {
  ticker: string;
  project: string;
  oftName: string;
  address?: string | null;
  messages: number;
  usdVolume: number;
  messagesFromMantle: number;
  messagesToMantle: number;
}

export interface MantleOftsResponse {
  queryId: string;
  source: string;
  count: number;
  ofts: MantleOft[];
}

export async function getMantleOfts(): Promise<MantleOftsResponse> {
  const res = await fetch(`${BASE}/mantle/ofts`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to load Mantle OFTs");
  }
  return res.json();
}

// ── Sentinel ──────────────────────────────────────────────────────────────

export interface TransactionIntent {
  intent: string;
  action: string;
  corridors?: string[];
  dvnAddress?: string;
  dvnName?: string;
  currentState: string;
  targetState: string;
  reason: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS";
  preflight?: {
    scoreBefore: number;
    riskBefore: "PASS" | "AT_RISK" | "CRITICAL";
    scoreAfter: number;
    riskAfter: "PASS" | "AT_RISK" | "CRITICAL";
  };
}

export interface PolicyDecisionRecord {
  oft: string;
  chainId: number;
  findings: Array<{ severity: string; check: string; detail: string }>;
  score: number;
  riskLevel: "PASS" | "AT_RISK" | "CRITICAL";
  evaluatedAt: number;
  agentId: number;
  rulesVersion: string;
}

export interface SentinelVerdict {
  oft: string;
  chainId: number;
  ticker: string;
  score: number;
  riskLevel: "PASS" | "AT_RISK" | "CRITICAL";
  verdict: string;
  reasons: string[];
  verdictHash: string;
  attestationId?: string;
  attestTxHash?: string;
  alertTxHash?: string;
  capturedAt: number;
  tis?: TransactionIntent[];
  pdr?: PolicyDecisionRecord;
}

export interface WatchedStatus {
  ticker: string;
  address: string;
  chainId: number;
  lastSnapshotAt: number | null;
  corridors?: string[];
  assessment: {
    score: number;
    riskLevel: "PASS" | "AT_RISK" | "CRITICAL";
    reasons: string[];
    tis: TransactionIntent[];
  } | null;
  latestVerdict: SentinelVerdict | null;
  dvnSummary: { requiredCount: number; optionalThreshold: number; effectiveCount: number; requiredDVNs: string[]; optionalDVNs: string[] } | null;
  dvnNames: Record<string, string> | null;
}

/** A chain the Sentinel currently watches — served by /status, derived from the
 *  backend chain registry. The ONLY source of chain names in the UI: never
 *  hardcode chain names in frontend copy, so adding a chain on the backend
 *  updates the whole frontend automatically. */
export interface WatchedChain {
  chainId: number;
  chainKey: string | null;
  name: string;
  count: number;
}

export interface SentinelStatus {
  watched: WatchedStatus[];
  chains?: WatchedChain[];
  msi: number | null;
  msiBreakdown: { critical: number; atRisk: number; safe: number; unassessed: number } | null;
  registry?: string;
  alertBus?: string;
}

export interface HistoryEntry {
  score: number;
  riskLevel: string;
  capturedAt: number;
}

export interface FeedEvent {
  type: "drift" | "attest" | "poll";
  ticker: string;
  detail: string;
  timestamp: number;
  score?: number;
  riskLevel?: string;
  txHash?: string;
}

export async function getSentinelStatus(): Promise<SentinelStatus> {
  const res = await fetch(`${BASE}/sentinel/status`);
  if (!res.ok) throw new Error("Failed to load Sentinel status");
  return res.json();
}

export async function getSentinelVerdicts(): Promise<SentinelVerdict[]> {
  const res = await fetch(`${BASE}/sentinel/verdicts`);
  if (!res.ok) throw new Error("Failed to load verdicts");
  return (await res.json()).verdicts ?? [];
}

export async function runKelpReplay(): Promise<SentinelVerdict> {
  const res = await fetch(`${BASE}/sentinel/replay-kelp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Kelp replay failed");
  }
  return (await res.json()).verdict;
}

export async function pollSentinel(): Promise<void> {
  const res = await fetch(`${BASE}/sentinel/poll`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Poll failed");
  }
}

export async function getReport(address: string): Promise<{ ticker: string; markdown: string }> {
  const res = await fetch(`${BASE}/sentinel/report/${address}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Report generation failed");
  }
  return res.json();
}

export async function runRpcConflictReplay(): Promise<SentinelVerdict> {
  const res = await fetch(`${BASE}/sentinel/replay-rpc-conflict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "RPC conflict replay failed");
  }
  return (await res.json()).verdict;
}

export async function runLibraryRevertReplay(): Promise<SentinelVerdict> {
  const res = await fetch(`${BASE}/sentinel/replay-library-revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Library revert replay failed");
  }
  return (await res.json()).verdict;
}

export async function getOftHistory(address: string): Promise<HistoryEntry[]> {
  const res = await fetch(`${BASE}/sentinel/history/${address}`);
  if (!res.ok) return [];
  return (await res.json()).history ?? [];
}

/** Score history for every watched OFT in one call — keyed by lowercase address. */
export async function getAllHistories(): Promise<Record<string, HistoryEntry[]>> {
  const res = await fetch(`${BASE}/sentinel/history`);
  if (!res.ok) return {};
  return (await res.json()).histories ?? {};
}

export async function resetDemo(): Promise<void> {
  const res = await fetch(`${BASE}/sentinel/reset-demo`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Demo reset failed");
  }
}

export async function getFeed(): Promise<FeedEvent[]> {
  const res = await fetch(`${BASE}/sentinel/feed`);
  if (!res.ok) return [];
  return (await res.json()).events ?? [];
}

export interface CopilotResponse {
  answer: string;
  relevantOfts: string[];
  remaining?: number;
  limit?: number;
}

export async function askSecurityCopilot(question: string): Promise<CopilotResponse> {
  const res = await fetch(`${BASE}/sentinel/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Copilot request failed");
  }
  return res.json();
}
