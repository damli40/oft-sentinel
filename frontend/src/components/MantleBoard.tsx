import type { MantleOft } from "../api.ts";
import type { WatchedStatus } from "../api.ts";

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function getStatusCls(w?: WatchedStatus): string {
  if (!w?.assessment) return "spill s-scan";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "spill s-crit";
  if (r === "AT_RISK")  return "spill s-warn";
  return "spill s-safe";
}

function getStatusLabel(w?: WatchedStatus): string {
  if (!w?.assessment) return "Scanning";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "Critical";
  if (r === "AT_RISK")  return "At risk";
  return "Safe";
}

interface Props {
  ofts: MantleOft[] | null;
  error?: string;
  status?: WatchedStatus[];
  onPick: (ticker: string) => void;
}

export function MantleBoard({ ofts, error, status, onPick }: Props) {
  const rows = ofts ?? [];
  const sorted = [...rows].sort((a, b) => b.usdVolume - a.usdVolume);

  // build ticker → WatchedStatus lookup
  const statusMap = new Map<string, WatchedStatus>();
  status?.forEach(w => statusMap.set(w.ticker.toUpperCase(), w));

  return (
    <div className="board">
      <table>
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Token</th>
            <th>Address</th>
            <th style={{ textAlign: "right" }}>All-time Volume</th>
            <th style={{ textAlign: "right" }}>Sentinel status</th>
          </tr>
        </thead>
        <tbody>
          {!ofts && !error && Array.from({ length: 8 }).map((_, i) => (
            <tr key={i}>
              <td className="rank" style={{ color: "var(--ghost)" }}>{String(i + 1).padStart(2, "0")}</td>
              <td><div style={{ height: 14, width: 60, background: "var(--surface-3)", borderRadius: 4 }} /></td>
              <td><div style={{ height: 12, width: 120, background: "var(--surface-3)", borderRadius: 4 }} /></td>
              <td style={{ textAlign: "right" }}><div style={{ height: 14, width: 48, background: "var(--surface-3)", borderRadius: 4, marginLeft: "auto" }} /></td>
              <td style={{ textAlign: "right" }}><div style={{ height: 20, width: 64, background: "var(--surface-3)", borderRadius: 7, marginLeft: "auto" }} /></td>
            </tr>
          ))}
          {error && (
            <tr><td colSpan={5} style={{ padding: "20px 18px", color: "var(--text-2)", fontSize: 13 }}>Couldn't load live data: {error}</td></tr>
          )}
          {sorted.map((o, i) => {
            const w = statusMap.get(o.ticker.toUpperCase());
            return (
              <tr key={o.oftName} onClick={() => onPick(o.ticker)}>
                <td className="rank">{String(i + 1).padStart(2, "0")}</td>
                <td>
                  <div className="tk">{o.ticker}</div>
                  <div className="addr" style={{ marginTop: 2 }}>{o.project}</div>
                </td>
                <td className="addr">{o.address ? shortAddr(o.address) : o.oftName || '—'}</td>
                <td className="vol">{formatUsd(o.usdVolume)}</td>
                <td style={{ textAlign: "right" }}>
                  <span className={getStatusCls(w)}>
                    <span className="d" />
                    {getStatusLabel(w)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
