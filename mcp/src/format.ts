// Distillers: the prod /status payload is ~660KB; tool results must carry only
// what an agent needs to decide its next call.

export type RiskLevel = "PASS" | "AT_RISK" | "CRITICAL";
export type RowRisk = RiskLevel | "UNASSESSED";

export interface StatusPayload {
  rulesVersion: string;
  chains: Array<{ chainId: number; name: string }>;
  watched: WatchedEntry[];
}

export interface WatchedEntry {
  ticker: string;
  address: string;
  chainId: number;
  lastSnapshotAt: number | null;
  corridors: string[];
  assessment?: {
    score: number;
    riskLevel: RiskLevel;
    reasons: string[];
    tis: Array<{ action: string; severity?: string; corridors?: string[] }>;
  } | null;
}

export interface FleetRow {
  ticker: string;
  address: string;
  chainId: number;
  chain: string;
  riskLevel: RowRisk;
  score: number | null;
  corridors: string[];
  lastSnapshotAt: number | null;
}

export function fleetRows(status: StatusPayload): FleetRow[] {
  const chainName = new Map(status.chains.map((c) => [c.chainId, c.name]));
  return status.watched.map((w) => ({
    ticker: w.ticker,
    address: w.address,
    chainId: w.chainId,
    chain: chainName.get(w.chainId) ?? String(w.chainId),
    riskLevel: w.assessment?.riskLevel ?? "UNASSESSED",
    score: w.assessment?.score ?? null,
    corridors: w.corridors ?? [],
    lastSnapshotAt: w.lastSnapshotAt ?? null,
  }));
}

/** One-line fleet posture, e.g. "175 OFTs watched across 3 chains — 22 CRITICAL / 75 AT_RISK / 64 PASS / 13 UNASSESSED (rules 4.1.0)". */
export function fleetSummary(rows: FleetRow[], rulesVersion: string): string {
  const bands: Record<RowRisk, number> = { CRITICAL: 0, AT_RISK: 0, PASS: 0, UNASSESSED: 0 };
  for (const r of rows) bands[r.riskLevel]++;
  const chains = new Set(rows.map((r) => r.chainId)).size;
  const parts = (Object.keys(bands) as RowRisk[])
    .filter((b) => bands[b] > 0)
    .map((b) => `${bands[b]} ${b}`);
  return `${rows.length} OFTs watched across ${chains} chain(s) — ${parts.join(" / ")} (rules ${rulesVersion})`;
}
