import { useState } from "react";
import type { MantleOft, WatchedStatus } from "../api.ts";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  5000: "Mantle",
  56: "BNB Chain",
  42161: "Arbitrum",
};

function chainName(id: number): string {
  return CHAIN_NAMES[id] ?? `Chain ${id}`;
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function statusCls(w: WatchedStatus): string {
  if (!w.assessment) return "spill s-scan";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "spill s-crit";
  if (r === "AT_RISK") return "spill s-warn";
  return "spill s-safe";
}

function statusLabel(w: WatchedStatus): string {
  if (!w.assessment) return "Scanning";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "Critical";
  if (r === "AT_RISK") return "At risk";
  return "Safe";
}

const RISK_RANK: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, PASS: 2 };

interface Props {
  status: WatchedStatus[] | undefined;
  /** Dune volume data — Mantle only; used to add a volume column on that tab. */
  ofts: MantleOft[] | null;
}

export function FleetBoard({ status, ofts }: Props) {
  const watched = status ?? [];

  // chains present in the live fleet, biggest first
  const counts = new Map<number, number>();
  watched.forEach(w => counts.set(w.chainId, (counts.get(w.chainId) ?? 0) + 1));
  const chains = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const [selected, setSelected] = useState<number | null>(null);
  const activeChain = selected ?? chains[0]?.[0] ?? null;

  // Mantle volume lookup (by address, ticker as fallback)
  const volByAddr = new Map<string, number>();
  const volByTicker = new Map<string, number>();
  ofts?.forEach(o => {
    if (o.address) volByAddr.set(o.address.toLowerCase(), o.usdVolume);
    volByTicker.set(o.ticker.toUpperCase(), o.usdVolume);
  });
  const volumeOf = (w: WatchedStatus): number | null =>
    w.chainId === 5000
      ? volByAddr.get(w.address.toLowerCase()) ?? volByTicker.get(w.ticker.toUpperCase()) ?? null
      : null;
  const showVolume = activeChain === 5000 && volByAddr.size + volByTicker.size > 0;

  const rows = watched
    .filter(w => w.chainId === activeChain)
    .sort((a, b) => {
      if (showVolume) return (volumeOf(b) ?? 0) - (volumeOf(a) ?? 0);
      const ra = a.assessment ? RISK_RANK[a.assessment.riskLevel] ?? 3 : 3;
      const rb = b.assessment ? RISK_RANK[b.assessment.riskLevel] ?? 3 : 3;
      return ra - rb || a.ticker.localeCompare(b.ticker);
    });

  return (
    <div>
      {chains.length > 0 && (
        <div className="fleet-tabs">
          {chains.map(([id, n]) => (
            <button
              key={id}
              className={`fleet-tab${id === activeChain ? " on" : ""}`}
              onClick={() => setSelected(id)}
            >
              {chainName(id)} <span className="n">{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="board">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Token</th>
              <th>Address</th>
              {showVolume && <th style={{ textAlign: "right" }}>All-time Volume</th>}
              <th style={{ textAlign: "right" }}>Sentinel status</th>
            </tr>
          </thead>
          <tbody>
            {!status && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}>
                <td className="rank" style={{ color: "var(--ghost)" }}>{String(i + 1).padStart(2, "0")}</td>
                <td><div style={{ height: 14, width: 60, background: "var(--surface-3)", borderRadius: 4 }} /></td>
                <td><div style={{ height: 12, width: 120, background: "var(--surface-3)", borderRadius: 4 }} /></td>
                <td style={{ textAlign: "right" }}><div style={{ height: 20, width: 64, background: "var(--surface-3)", borderRadius: 7, marginLeft: "auto" }} /></td>
              </tr>
            ))}
            {status && rows.length === 0 && (
              <tr><td colSpan={showVolume ? 5 : 4} style={{ padding: "20px 18px", color: "var(--text-2)", fontSize: 13 }}>No OFTs watched on this chain yet.</td></tr>
            )}
            {rows.map((w, i) => {
              const vol = showVolume ? volumeOf(w) : null;
              return (
                <tr key={`${w.chainId}:${w.address}`}>
                  <td className="rank">{String(i + 1).padStart(2, "0")}</td>
                  <td><div className="tk">{w.ticker}</div></td>
                  <td className="addr">{shortAddr(w.address)}</td>
                  {showVolume && <td className="vol">{vol !== null ? formatUsd(vol) : "—"}</td>}
                  <td style={{ textAlign: "right" }}>
                    <span className={statusCls(w)}>
                      <span className="d" />
                      {statusLabel(w)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
