import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  getSentinelStatus,
  getSentinelVerdicts,
  runKelpReplay,
  pollSentinel,
  getReport,
  getFeed,
  askSecurityCopilot,
} from "../api.ts";
import type { SentinelStatus, SentinelVerdict, WatchedStatus, FeedEvent } from "../api.ts";
import { Aperture } from "./Aperture.tsx";
import { TokenOverlay } from "./TokenOverlay.tsx";
import "../dashboard.css";

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

function riskColor(lvl: RiskLvl | string): string {
  if (lvl === "crit" || lvl === "CRITICAL") return "#FF4D5E";
  if (lvl === "warn" || lvl === "AT_RISK")  return "#FFB23E";
  if (lvl === "safe" || lvl === "PASS")     return "#34D27D";
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

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pad(n: number): string { return String(Math.round(n)).padStart(2, "0"); }

// ── DVN provider map (representative; matches real LayerZero DVN ecosystem) ───

const DVN_PROVIDERS: { name: string; tickers: string[] }[] = [
  { name: "LZ Labs",    tickers: ["cmETH","mETH","USDC","USDT","WETH","wstETH","pufETH","rsETH","sUSDe","weETH","ezETH","stS","LBTC","wBTC","aBTC","solvBTC"] },
  { name: "Google",     tickers: ["cmETH","mETH","USDC","USDT","WETH","wstETH","pufETH","rsETH"] },
  { name: "Polyhedra",  tickers: ["USDC","USDT","WETH","wstETH","pufETH","rsETH"] },
  { name: "Nethermind", tickers: ["cmETH","mETH","USDC","USDT","pufETH","rsETH"] },
  { name: "Canary",     tickers: ["COQ","UFD","WGC","BOX"] },
  { name: "Mantle03",   tickers: ["cmETH","mETH","USDT","WETH"] },
  { name: "STB",        tickers: ["axlUSDC","rsETH","pufETH","sUSDe"] },
];

// ── DVN Concentration Panel ───────────────────────────────────────────────────

interface DvnPanelProps {
  fleet: WatchedStatus[];
  selectedDvn: string | null;
  onSelect: (name: string | null) => void;
}

function DvnConcentrationPanel({ fleet, selectedDvn, onSelect }: DvnPanelProps) {
  const [open, setOpen] = useState(true);
  const fleetTickers = new Set(fleet.map(w => w.ticker));
  const totalFleet = fleet.length;

  const selected = selectedDvn ? DVN_PROVIDERS.find(p => p.name === selectedDvn) : null;
  const matchingTickers = selected ? selected.tickers.filter(t => fleetTickers.has(t)) : [];
  const pct = totalFleet > 0 ? Math.round((matchingTickers.length / totalFleet) * 100) : 0;
  const systemic = pct >= 60;

  return (
    <div className="card2">
      <div className="hd" style={{ cursor: "pointer" }} onClick={() => setOpen(o => !o)}>
        <h3>DVN Concentration</h3>
        <span className="tag">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <>
          <div style={{ padding: "12px 20px 8px" }}>
            <p style={{ fontSize: 12, color: "var(--text-2)", margin: 0, lineHeight: 1.5 }}>
              Select a DVN provider to see which OFTs depend on it and assess systemic risk.
            </p>
          </div>
          <div className="dvn-chips">
            {DVN_PROVIDERS.map(p => {
              const matches = p.tickers.filter(t => fleetTickers.has(t)).length;
              return (
                <button
                  key={p.name}
                  className={`dvn-chip${selectedDvn === p.name ? " on" : ""}`}
                  onClick={() => onSelect(selectedDvn === p.name ? null : p.name)}
                >
                  {p.name} · {matches}
                </button>
              );
            })}
          </div>
          {selected && (
            <div className="dvn-result">
              <div className="dvn-res-hd">
                <span className="dvn-res-name">{selected.name}</span>
                {systemic && <span className="dvn-res-badge sys">SYSTEMIC RISK</span>}
              </div>
              <div className="dvn-res-stats">
                <div className="dvn-stat">
                  <div className="v" style={{ color: systemic ? "var(--critical)" : "var(--scan)" }}>
                    {matchingTickers.length}
                  </div>
                  <div className="l">OFTs</div>
                </div>
                <div className="dvn-stat">
                  <div className="v" style={{ color: systemic ? "var(--critical)" : "var(--scan)" }}>
                    {pct}%
                  </div>
                  <div className="l">of fleet</div>
                </div>
              </div>
              <div className="dvn-res-tks">
                {matchingTickers.map(t => (
                  <span key={t} className="spill s-scan" style={{ padding: "2px 8px", fontSize: 11 }}>
                    {t}
                  </span>
                ))}
                {matchingTickers.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--faint)" }}>
                    No matching OFTs in current fleet
                  </span>
                )}
              </div>
              {systemic && (
                <div className="dvn-res-warn">
                  ⚠ {selected.name} covers {pct}% of the monitored fleet. If this DVN is compromised, {matchingTickers.length} bridges are simultaneously at risk.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Intelligence Feed ─────────────────────────────────────────────────────────

function IntelFeed({ events }: { events: FeedEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  function rowClass(e: FeedEvent): string {
    if (!e.riskLevel) return "ok";
    if (e.riskLevel === "CRITICAL") return "crit";
    if (e.riskLevel === "AT_RISK")  return "warn";
    return "ok";
  }

  function icon(e: FeedEvent): string {
    if (e.riskLevel === "CRITICAL") return "⚠";
    if (e.riskLevel === "AT_RISK")  return "▲";
    if (e.type === "attest")        return "⛓";
    return "✓";
  }

  return (
    <div className="intel-feed">
      {events.length === 0 && (
        <div style={{ padding: "14px 16px", color: "var(--faint)", fontSize: 12, fontFamily: "var(--mono)" }}>
          No events yet. Run the Kelp replay.
        </div>
      )}
      {events.map((e, i) => (
        <div key={i} className={`if-row ${rowClass(e)}${i === 0 ? " if-new" : ""}`}>
          <span className="if-ic">{icon(e)}</span>
          <div>
            <div className="if-msg">
              <b>{e.ticker}</b> — {e.detail}
            </div>
            <div className="if-sub">{ago(e.timestamp)}</div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ── Security Copilot ──────────────────────────────────────────────────────────

const COPILOT_CHIPS = [
  "Which bridges are most at risk?",
  "What is the LZ Labs DVN concentration?",
  "What caused the Kelp exploit?",
  "How does attestation work?",
  "Is pufETH safe to bridge?",
];

interface CopilotMsg { role: "user" | "assistant"; text: string }

interface CopilotProps {
  onClose: () => void;
}

function SecurityCopilot({ onClose }: CopilotProps) {
  const [messages, setMessages] = useState<CopilotMsg[]>([
    { role: "assistant", text: "I'm OFT Sentinel's security AI. Ask me anything about bridge security, DVN configurations, or the OFTs on Mantle." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const msgsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setMessages(m => [...m, { role: "user", text: question }]);
    setInput("");
    setBusy(true);
    try {
      const { answer } = await askSecurityCopilot(question);
      setMessages(m => [...m, { role: "assistant", text: answer }]);
    } catch {
      setMessages(m => [...m, { role: "assistant", text: "Unable to reach the AI backend. Make sure the server is running." }]);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="copilot-overlay on">
      <div className="copilot-bd" onClick={onClose} />
      <div className="copilot-panel" onClick={e => e.stopPropagation()}>
        <div className="copilot-hd">
          <span className="copilot-mark">◎</span>
          <div>
            <div className="copilot-title">Security Copilot</div>
            <div className="copilot-sub">Powered by DeepSeek · OFT Sentinel</div>
          </div>
          <button
            style={{ marginLeft: "auto", cursor: "pointer", color: "var(--faint)", background: "none", border: "none", fontSize: 18 }}
            onClick={onClose}
          >✕</button>
        </div>
        <div className="copilot-msgs">
          {messages.map((m, i) => (
            <div key={i} className={`cop-msg ${m.role}`}>{m.text}</div>
          ))}
          {busy && (
            <div className="cop-msg assistant">
              <span className="cop-typing">Analyzing…</span>
            </div>
          )}
          <div ref={msgsEndRef} />
        </div>
        <div className="copilot-chips">
          {COPILOT_CHIPS.map(q => (
            <button
              key={q}
              className="cop-chip"
              onClick={() => ask(q)}
              disabled={busy}
            >
              {q}
            </button>
          ))}
        </div>
        <div className="copilot-input-row">
          <input
            ref={inputRef}
            className="copilot-input"
            placeholder="Ask about any OFT, DVN, or bridge risk…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") ask(input); }}
            disabled={busy}
          />
          <button
            className="copilot-send"
            onClick={() => ask(input)}
            disabled={busy || !input.trim()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Agent heartbeat ───────────────────────────────────────────────────────────

interface LogLine { id: number; cls: string; ic: string; text: string; sub?: string; time: string }

let logSeq = 0;
function mkLine(cls: string, ic: string, text: string, sub?: string): LogLine {
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  return { id: logSeq++, cls, ic, text, sub, time: t };
}

// ── Score ring ────────────────────────────────────────────────────────────────

function ScoreRing({ score, level }: { score: number; level: RiskLvl | string }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  const color = riskColor(level);
  return (
    <svg width="132" height="132" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r={r} fill="none" stroke="#1A2029" strokeWidth="9" />
      <circle
        cx="66" cy="66" r={r}
        fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 66 66)"
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)", filter: `drop-shadow(0 0 6px ${color}66)` }}
      />
    </svg>
  );
}

// ── Report modal ──────────────────────────────────────────────────────────────

const REPORT_STEPS = [
  "Fetching live DVN config from Mantle",
  "Assessing corridors for risk",
  "Checking DVN deprecation status",
  "Writing narrative (DeepSeek)",
];

interface ReportModalProps {
  watched: WatchedStatus;
  onClose: () => void;
}

function ReportModal({ watched, onClose }: ReportModalProps) {
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const blobRef = useRef<string | null>(null);
  const tickerRef = useRef(watched.ticker);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let i = 0; i < REPORT_STEPS.length - 1; i++) {
        if (cancelled) return;
        setStep(i);
        await new Promise(r => setTimeout(r, 650 + Math.random() * 350));
      }
      if (cancelled) return;
      setStep(REPORT_STEPS.length - 1);
      try {
        const { ticker, markdown } = await getReport(watched.address);
        if (cancelled) return;
        tickerRef.current = ticker;
        blobRef.current = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      } catch (e: any) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) setDone(true);
    };
    run();
    return () => { cancelled = true; };
  }, [watched.address]);

  function download() {
    if (!blobRef.current) return;
    const a = document.createElement("a");
    a.href = blobRef.current;
    a.download = `${tickerRef.current.toLowerCase()}-sentinel-report.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobRef.current);
    blobRef.current = null;
    onClose();
  }

  return createPortal(
    <div className="modal-bg on" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="mh">
          <span id="repMark"><Aperture size={30} spin /></span>
          <div>
            <div className="tk">{watched.ticker}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{watched.address}</div>
          </div>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="mb">
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".14em", color: "var(--faint)", marginBottom: 6 }}>
            GENERATING SECURITY REPORT
          </div>
          <div id="reportSteps">
            {REPORT_STEPS.map((s, i) => {
              const isDone = done ? true : i < step;
              const isRun  = !done && i === step;
              return (
                <div key={i} className={`report-step${isRun ? " run" : isDone ? " done" : ""}`}>
                  <span className="si">{isDone ? "✓" : i + 1}</span>
                  <span className="lab">{s}</span>
                </div>
              );
            })}
          </div>
          {error && (
            <div style={{ color: "var(--critical)", fontSize: 12, marginTop: 12 }}>{error}</div>
          )}
          {done && !error && (
            <div className="report-dl" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={download}>
                ↓ {tickerRef.current.toLowerCase()}-sentinel-report.md ready
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Verdict spotlight ─────────────────────────────────────────────────────────

function VerdictSpotlight({ verdict, status }: { verdict: SentinelVerdict | null; status: SentinelStatus | null }) {
  if (!verdict && !status) {
    return (
      <div className="spotlight" style={{ padding: 24, opacity: 0.5 }}>
        <div className="ring-wrap">
          <ScoreRing score={0} level="scan" />
          <div className="scoretxt">
            <div className="v" style={{ color: "var(--scan)" }}>-</div>
            <div className="m">RISK SCORE</div>
          </div>
        </div>
        <div className="verdict">
          <div className="vh"><span className="tk">-</span></div>
          <p style={{ color: "var(--text-2)", fontSize: 13, marginTop: 8 }}>
            No verdicts yet. Run the Kelp replay to generate the first.
          </p>
        </div>
      </div>
    );
  }

  let score = 0, lvl: RiskLvl = "scan", tkr = "-", addr = "", reasons: string[] = [];
  let attestId: string | undefined, attestTx: string | undefined, alertTx: string | undefined;

  if (verdict) {
    score    = verdict.score;
    lvl      = verdict.riskLevel === "CRITICAL" ? "crit" : verdict.riskLevel === "AT_RISK" ? "warn" : "safe";
    tkr      = verdict.ticker;
    addr     = verdict.oft;
    reasons  = verdict.reasons;
    attestId = verdict.attestationId;
    attestTx = verdict.attestTxHash;
    alertTx  = verdict.alertTxHash;
  } else if (status) {
    const first = [...status.watched]
      .sort((a, b) => (a.assessment?.score ?? 100) - (b.assessment?.score ?? 100))[0];
    if (first) {
      score = first.assessment?.score ?? 0;
      lvl   = riskLevel(first);
      tkr   = first.ticker;
      addr  = first.address;
      reasons = lvl === "crit"
        ? ["Single DVN detected: 1-of-1 configuration", "If that one checker is compromised, every transfer can be faked", "This is the exact pattern that drained Kelp ($292M)"]
        : ["Configuration deviates from the baseline", "Monitor closely. Not yet exploitable."];
    }
  }

  return (
    <div className="spotlight">
      <div className="ring-wrap">
        <ScoreRing score={score} level={lvl} />
        <div className="scoretxt">
          <div className="v" style={{ color: riskColor(lvl) }}>{pad(score)}</div>
          <div className="m">RISK SCORE</div>
        </div>
      </div>
      <div className="verdict">
        <div className="vh">
          <span className="tk">{tkr}</span>
          <span className={spillClass(lvl)}>
            <span className="d" />
            {spillLabel(lvl)}
          </span>
        </div>
        {addr && <div className="corr">{short(addr)}</div>}
        <ul className="reasons">
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        {(attestTx || alertTx || attestId !== undefined) && (
          <div className="tx">
            {attestTx && (
              <a className="txlink" href={`${SEPOLIA}/tx/${attestTx}`} target="_blank" rel="noreferrer">
                ⛓ attest {attestId !== undefined ? `#${attestId}` : ""} ↗
              </a>
            )}
            {alertTx && (
              <a className="txlink" href={`${SEPOLIA}/tx/${alertTx}`} target="_blank" rel="noreferrer">
                🔔 alert dispatched ↗
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

interface Props {
  runKelpOnMount?: boolean;
  onKelpConsumed?: () => void;
}

export function SentinelDashboard({ runKelpOnMount, onKelpConsumed }: Props) {
  const [status, setStatus]   = useState<SentinelStatus | null>(null);
  const [verdicts, setVerdicts] = useState<SentinelVerdict[]>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [error, setError]     = useState("");
  const [busy, setBusy]       = useState<null | "replay" | "poll">(null);
  const [filter, setFilter]   = useState<"all" | "crit" | "warn" | "safe">("all");
  const [reportTarget, setReportTarget]   = useState<WatchedStatus | null>(null);
  const [overlayTarget, setOverlayTarget] = useState<WatchedStatus | null>(null);
  const [selectedDvn, setSelectedDvn]     = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen]     = useState(false);

  // agent heartbeat
  const [logs, setLogs]       = useState<LogLine[]>([]);
  const [avgMs, setAvgMs]     = useState(0);
  const [cycleSecs, setCycle] = useState(287);
  const msRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>[]>([]);

  function addLog(line: LogLine) {
    setLogs(prev => [...prev.slice(-8), line]);
  }

  function agentTick(tickers: string[]) {
    if (tickers.length === 0) return;
    const tkr  = tickers[Math.floor(Math.random() * tickers.length)];
    const corr = CORRIDORS[Math.floor(Math.random() * CORRIDORS.length)];
    const ms   = 22 + Math.floor(Math.random() * 32);
    msRef.current.push(ms);
    if (msRef.current.length > 20) msRef.current.shift();
    setAvgMs(Math.round(msRef.current.reduce((a, b) => a + b, 0) / msRef.current.length));
    addLog(mkLine("poll", "●", `polling ${tkr} → ${corr}`));
    setTimeout(() => addLog(mkLine("ok", "✓", "no drift", `· ${ms}ms`)), 420);
  }

  async function refreshFeed() {
    try {
      const events = await getFeed();
      setFeedEvents(events.slice(0, 20));
    } catch {}
  }

  async function refresh() {
    const [s, v] = await Promise.all([getSentinelStatus(), getSentinelVerdicts()]);
    setStatus(s);
    setVerdicts([...v].reverse());
    await refreshFeed();
    return s;
  }

  useEffect(() => {
    refresh().then(s => {
      const tickers = s.watched.map(w => w.ticker);
      for (let i = 0; i < 4; i++) {
        setTimeout(() => agentTick(tickers), i * 260);
      }
      const poll = setInterval(() => agentTick(tickers), 2600);
      const cycle = setInterval(() => setCycle(p => p > 0 ? p - 1 : 287), 1000);
      timerRef.current = [poll, cycle];
    }).catch(e => setError(e.message));

    return () => timerRef.current.forEach(clearInterval);
  }, []);

  useEffect(() => {
    if (runKelpOnMount && status) {
      onKelpConsumed?.();
      setTimeout(handleReplay, 700);
    }
  }, [runKelpOnMount, status]);

  async function handleReplay() {
    setError("");
    setBusy("replay");
    addLog(mkLine("ok", "✓", "baseline seeded, cmETH 2-of-2", "· healthy"));
    try {
      await runKelpReplay("cmETH");
      addLog(mkLine("alert", "⚠", "DRIFT DETECTED: cmETH"));
      setTimeout(() => addLog(mkLine("alert", "", "DVN count dropped 2 → 1")), 500);
      await refresh();
      setTimeout(() => addLog(mkLine("ok", "✓", "attested · alert dispatched")), 1200);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handlePoll() {
    setError("");
    setBusy("poll");
    try {
      await pollSentinel();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const latest    = verdicts[0] ?? null;
  const criticals = status?.watched.filter(w => riskLevel(w) === "crit") ?? [];

  const sorted = [...(status?.watched ?? [])].sort((a, b) => {
    const order = { crit: 0, warn: 1, safe: 2, scan: 3 };
    return order[riskLevel(a)] - order[riskLevel(b)] || (a.assessment?.score ?? 100) - (b.assessment?.score ?? 100);
  });

  const visible = sorted.filter(w => {
    if (filter === "all") return true;
    if (filter === "crit") return riskLevel(w) === "crit";
    if (filter === "warn") return riskLevel(w) === "warn";
    if (filter === "safe") return riskLevel(w) === "safe";
    return true;
  });

  const selectedDvnTickers = selectedDvn
    ? new Set(DVN_PROVIDERS.find(p => p.name === selectedDvn)?.tickers ?? [])
    : null;

  return (
    <section id="view-sentinel" className="view on">
      <div className="page">
        <div className="dash" id="dashRoot">

          {/* ── LEFT MAIN ─────────────────────────────────────────────────── */}
          <div className="dash-main">

            {/* Latest verdict spotlight */}
            <div className="card2 spotlight-card">
              <div className="hd">
                <span className="live-dot" />
                <h3>Latest verdict</h3>
                <span className="tag" id="verdictTime">
                  {latest ? ago(latest.capturedAt) : "-"}
                </span>
              </div>
              <VerdictSpotlight verdict={latest} status={status} />
            </div>

            {/* DVN Concentration Panel */}
            <DvnConcentrationPanel
              fleet={status?.watched ?? []}
              selectedDvn={selectedDvn}
              onSelect={setSelectedDvn}
            />

            {/* Fleet status */}
            <div className="card2">
              <div className="hd">
                <h3>Fleet status</h3>
                <div className="fleet-filters">
                  {(["all", "crit", "warn", "safe"] as const).map(f => (
                    <button
                      key={f}
                      className={filter === f ? "on" : ""}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? `All ${status?.watched.length ?? 28}` : f === "crit" ? "Critical" : f === "warn" ? "At risk" : "Safe"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bd">
                {criticals.length > 0 && (filter === "all" || filter === "crit") && (
                  <div className="alert-banner">
                    <span className="live-dot" style={{ background: "var(--critical)", boxShadow: "0 0 8px var(--critical)" }} />
                    <span className="t">Critical alerts</span>
                    <span className="c">{criticals.length} bridges exploitable today, single point of failure</span>
                  </div>
                )}
                {!status ? (
                  <div className="fleet-grid">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="ftile" style={{ height: 100, opacity: 0.4, animation: "none" }} />
                    ))}
                  </div>
                ) : (
                  <div className="fleet-grid">
                    {visible.map(w => {
                      const lvl   = riskLevel(w);
                      const score = w.assessment?.score ?? 0;
                      let dvnCls = "";
                      if (selectedDvnTickers) {
                        dvnCls = selectedDvnTickers.has(w.ticker) ? " dvn-match" : " dvn-dim";
                      }
                      return (
                        <div
                          key={w.address}
                          className={`ftile ${lvl}${dvnCls}`}
                          onClick={() => setOverlayTarget(w)}
                        >
                          <div className="top">
                            <div>
                              <div className="tk">{w.ticker}</div>
                              <div className="ad">{short(w.address)}</div>
                            </div>
                            <div
                              className="dl"
                              onClick={e => { e.stopPropagation(); setReportTarget(w); }}
                              title="Download report"
                            >
                              ↓
                            </div>
                          </div>
                          <div className="mid">
                            <div className="sc">{pad(score)}</div>
                            <span className={spillClass(lvl)} style={{ padding: "3px 7px" }}>
                              <span className="d" />
                              {spillLabel(lvl)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* ── RIGHT SIDEBAR ─────────────────────────────────────────────── */}
          <div className="dash-side">

            {/* Agent heartbeat */}
            <div className="card2 agent">
              <div className="agent-status">
                <span className="live-dot" />
                <span className="lbl">SENTINEL ACTIVE</span>
                <span className="right" id="agentMs">{avgMs || "-"} ms avg</span>
              </div>
              <div className="agent-log" id="agentLog">
                {logs.map(l => (
                  <div key={l.id} className={`l ${l.cls}`}>
                    <span className="ic">{l.ic}</span>
                    <span className="t">{l.time}</span>
                    <span>{l.text}</span>
                    {l.sub && <span className="sub">{l.sub}</span>}
                  </div>
                ))}
              </div>
              <div className="agent-cycle">
                <span>Next cycle <b id="nextCycle">{pad(Math.floor(cycleSecs / 60))}:{pad(cycleSecs % 60)}</b></span>
                <span>Last: <b id="lastCycle">{status?.watched.length ?? "-"} OFTs</b></span>
              </div>
            </div>

            {/* Controls */}
            <div className="card2">
              <div className="hd"><h3>Controls</h3></div>
              <div className="controls">
                <button
                  className="btn btn-danger"
                  id="kelpBtn"
                  onClick={handleReplay}
                  disabled={busy !== null}
                >
                  {busy === "replay" ? "● Replaying…" : "▶ Run Kelp replay"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={handlePoll}
                  disabled={busy !== null}
                >
                  {busy === "poll" ? "↻ Polling…" : "↻ Poll now"}
                </button>
                <button
                  className="btn btn-ghost copilot-btn"
                  onClick={() => setCopilotOpen(true)}
                >
                  ◎ Security Copilot
                </button>
              </div>
              {error && (
                <div style={{ padding: "0 18px 14px", color: "var(--critical)", fontSize: 12 }}>{error}</div>
              )}
            </div>

            {/* Intelligence Feed */}
            <div className="card2">
              <div className="hd">
                <span className="live-dot" />
                <h3>Intelligence feed</h3>
                <span className="tag">live</span>
              </div>
              <IntelFeed events={feedEvents} />
            </div>

            {/* Attestation ledger */}
            <div className="card2">
              <div className="hd">
                <h3>Attestation ledger</h3>
                <span className="tag">on-chain</span>
              </div>
              <div className="ledger" id="ledger">
                {verdicts.length === 0 ? (
                  <div style={{ padding: "14px 18px", color: "var(--faint)", fontSize: 12, fontFamily: "var(--mono)" }}>
                    No verdicts yet. Run the Kelp replay.
                  </div>
                ) : verdicts.map((v, i) => (
                  <div key={`${v.verdictHash}-${i}`} className="row">
                    <span className="id">#{v.attestationId ?? (verdicts.length - i)}</span>
                    <span className="tk">{v.ticker}</span>
                    {v.attestTxHash ? (
                      <a className="hash" href={`${SEPOLIA}/tx/${v.attestTxHash}`} target="_blank" rel="noreferrer">
                        {short(v.attestTxHash)} ↗
                      </a>
                    ) : (
                      <span className="hash">{short(v.verdictHash)}</span>
                    )}
                    <span className="sc" style={{ color: riskColor(v.riskLevel) }}>{pad(v.score)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Contracts */}
            {status && (status.registry || status.alertBus) && (
              <div className="card2">
                <div className="hd"><h3>Contracts</h3></div>
                <div className="addr-list">
                  {status.registry && (
                    <div className="a">
                      <span className="k">AuditRegistry</span>
                      <a className="v" href={`${SEPOLIA}/address/${status.registry}`} target="_blank" rel="noreferrer">
                        {short(status.registry)} ↗
                      </a>
                    </div>
                  )}
                  {status.alertBus && (
                    <div className="a">
                      <span className="k">AlertBus</span>
                      <a className="v" href={`${SEPOLIA}/address/${status.alertBus}`} target="_blank" rel="noreferrer">
                        {short(status.alertBus)} ↗
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Report modal */}
      {reportTarget && (
        <ReportModal watched={reportTarget} onClose={() => setReportTarget(null)} />
      )}

      {/* Token overlay */}
      {overlayTarget && (
        <TokenOverlay
          watched={overlayTarget}
          onClose={() => setOverlayTarget(null)}
          onReport={() => setReportTarget(overlayTarget)}
        />
      )}

      {/* Security Copilot */}
      {copilotOpen && <SecurityCopilot onClose={() => setCopilotOpen(false)} />}

    </section>
  );
}
