import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { WatchedStatus } from "../api.ts";

const SEPOLIA = "https://sepolia.mantlescan.xyz";
const MAINNET  = "https://mantlescan.xyz";
const CORRIDORS = ["ethereum", "hyperliquid", "polygon", "arbitrum", "base", "optimism", "avalanche", "bsc", "sei", "berachain"];


type RiskLvl = "crit" | "warn" | "safe" | "scan";

function riskLevel(w: WatchedStatus): RiskLvl {
  if (!w.assessment) return "scan";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "crit";
  if (r === "AT_RISK")  return "warn";
  return "safe";
}

function riskColor(lvl: RiskLvl): string {
  if (lvl === "crit") return "#FF4D5E";
  if (lvl === "warn") return "#FFB23E";
  if (lvl === "safe") return "#34D27D";
  return "#5BE7F0";
}

function spillClass(lvl: RiskLvl): string {
  if (lvl === "crit") return "spill s-crit";
  if (lvl === "warn") return "spill s-warn";
  if (lvl === "safe") return "spill s-safe";
  return "spill s-scan";
}

function spillLabel(lvl: RiskLvl): string {
  if (lvl === "crit") return "Critical";
  if (lvl === "warn") return "At risk";
  if (lvl === "safe") return "Safe";
  return "Scanning";
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pad(n: number): string { return String(Math.round(n)).padStart(2, "0"); }

function ScoreRing({ score, level }: { score: number; level: RiskLvl }) {
  const r   = 58;
  const c   = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  const col = riskColor(level);
  return (
    <svg width="132" height="132" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r={r} fill="none" stroke="#1A2029" strokeWidth="9" />
      <circle
        cx="66" cy="66" r={r}
        fill="none" stroke={col} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 66 66)"
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)", filter: `drop-shadow(0 0 6px ${col}66)` }}
      />
    </svg>
  );
}

interface TokenOverlayProps {
  watched: WatchedStatus;
  onClose: () => void;
  onReport: () => void;
}

export function TokenOverlay({ watched, onClose, onReport }: TokenOverlayProps) {
  const lvl   = riskLevel(watched);
  const score = watched.assessment?.score ?? 0;
  const v     = watched.latestVerdict;

  const reasons: string[] = v?.reasons.length
    ? v.reasons
    : lvl === "crit"
      ? ["Single DVN detected: 1-of-1 configuration", "Exploitable if that checker is compromised", "Matches the Kelp ($292M) attack pattern"]
      : lvl === "warn"
        ? ["Configuration deviates from baseline", "Monitor closely — not yet exploitable"]
        : [];

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="token-overlay on">
      <div className="to-bd" onClick={onClose} />
      <div className="to-panel">

        {/* ── Header ── */}
        <div className="to-hd">
          <span className="to-tkn">{watched.ticker}</span>
          <span className={spillClass(lvl)} style={{ marginLeft: 10 }}>
            <span className="d" />{spillLabel(lvl)}
          </span>
          <span className="to-adr">{watched.address}</span>
          <button className="to-x" onClick={onClose}>✕</button>
        </div>

        {/* ── Body ── */}
        <div className="to-main">

          {/* Left: score ring + reasons */}
          <div className="to-score-col">
            <div style={{ position: "relative" }}>
              <ScoreRing score={score} level={lvl} />
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 40, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em", color: riskColor(lvl) }}>
                  {pad(score)}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", color: "var(--faint)", marginTop: 4 }}>
                  RISK SCORE
                </span>
              </div>
            </div>
            {reasons.length > 0 && (
              <ul className="to-rl">
                {reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>

          {/* Right: detail */}
          <div className="to-detail-col">

            {/* On-chain proof */}
            {(v?.attestTxHash || v?.alertTxHash) && (
              <div>
                <div className="to-sec-lbl">On-chain proof</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {v.attestTxHash && (
                    <a className="txlink" href={`${SEPOLIA}/tx/${v.attestTxHash}`} target="_blank" rel="noreferrer">
                      ⛓ attest{v.attestationId !== undefined ? ` #${v.attestationId}` : ""} ↗
                    </a>
                  )}
                  {v.alertTxHash && (
                    <a className="txlink" href={`${SEPOLIA}/tx/${v.alertTxHash}`} target="_blank" rel="noreferrer">
                      🔔 alert dispatched ↗
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* DVN configuration */}
            {watched.dvnSummary && (
              <div>
                <div className="to-sec-lbl">DVN Configuration</div>
                <div className="to-dvn-thresh">
                  Required: <b>{watched.dvnSummary.requiredCount}-of-{watched.dvnSummary.requiredDVNs.length}</b> DVNs
                  {watched.dvnSummary.requiredCount === 1 && watched.dvnSummary.requiredDVNs.length <= 1 && (
                    <span style={{ color: "var(--critical)", marginLeft: 8, fontSize: 11 }}>⚠ single point of failure</span>
                  )}
                </div>
                <div>
                  {watched.dvnSummary.requiredDVNs.map((addr, i) => {
                    const name = watched.dvnNames?.[addr] ?? `DVN ${i + 1}`;
                    const bad = watched.dvnSummary!.requiredCount === 1 && watched.dvnSummary!.requiredDVNs.length <= 1;
                    return (
                      <div key={addr} className="to-dvn-row">
                        <div>
                          <div className="to-dvn-nm">{name}</div>
                          <div className="to-dvn-ad">{addr.slice(0, 10)}…{addr.slice(-6)}</div>
                        </div>
                        <span className={`to-dvn-st ${bad ? "bad" : "ok"}`}>
                          {bad ? "⚠ sole checker" : "✓ active"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Monitored corridors */}
            <div>
              <div className="to-sec-lbl">Monitored corridors</div>
              <div className="to-corrs">
                {CORRIDORS.map(c => (
                  <span key={c} className="to-corr">{c}</span>
                ))}
              </div>
            </div>

            {/* Contract */}
            <div>
              <div className="to-sec-lbl">Contract on Mantle</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <a className="txlink" href={`${MAINNET}/address/${watched.address}`} target="_blank" rel="noreferrer">
                  {short(watched.address)} ↗
                </a>
              </div>
            </div>

            {/* Actions */}
            <div className="to-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { onClose(); onReport(); }}
              >
                ↓ Generate report
              </button>
              <a
                className="btn btn-ghost btn-sm"
                href={`${MAINNET}/address/${watched.address}`}
                target="_blank"
                rel="noreferrer"
              >
                Explorer ↗
              </a>
            </div>

          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
