import { useState, useEffect, useRef } from "react";
import { Aperture } from "./components/Aperture.tsx";
import { Storyboard } from "./components/Storyboard.tsx";
import { MantleBoard } from "./components/MantleBoard.tsx";
import { SentinelDashboard } from "./components/SentinelDashboard.tsx";
import { FlowAnimation } from "./components/FlowAnimation.tsx";
import { getMantleOfts, getSentinelStatus } from "./api.ts";
import type { MantleOft, SentinelStatus } from "./api.ts";
import "./landing.css";

type View = "app" | "story" | "sentinel";

function pad(n: number) { return String(Math.round(n)).padStart(2, "0"); }

function useCountUp(target: number, dur = 1400) {
  const [val, setVal] = useState(0);
  const ran = useRef(false);
  useEffect(() => {
    if (!target || ran.current) return;
    ran.current = true;
    const start = performance.now();
    const frame = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(target * e);
      if (p < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, [target, dur]);
  return val;
}

function formatVol(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Radar blips (decorative): [level, ring radius % of ringset, angle°] — placed
// ON the orbit rings (radii 44/33/22 = half the 88/66/44% ring diameters) so
// they stay on the rings at any card size or aspect ratio.
const BLIPS: [string, number, number][] = [
  ["crit", 44, 205], ["crit", 33, 55], ["crit", 22, 290],
  ["warn", 44, 100], ["warn", 33, 250], ["warn", 22, 150],
  ["safe", 44, 335], ["safe", 33, 20],
];

function blipColor(l: string) {
  if (l === "crit") return "#FF4D5E";
  if (l === "warn") return "#FFB23E";
  return "#34D27D";
}

function RadarCard() {
  return (
    <div className="radar-card">
      <div className="ringset">
        {[88, 66, 44, 22].map(p => (
          <div key={p} className="ring" style={{ width: `${p}%`, height: `${p}%` }} />
        ))}
        <div className="sweep" />
        {BLIPS.map(([lvl, r, deg], i) => {
          const size = lvl === "crit" ? 9 : lvl === "warn" ? 7 : 5;
          const color = blipColor(lvl);
          const rad = (deg * Math.PI) / 180;
          return (
            <div
              key={i}
              className="radar-blip"
              style={{
                left: `${50 + r * Math.cos(rad)}%`,
                top: `${50 + r * Math.sin(rad)}%`,
                transform: "translate(-50%, -50%)",
                width: size, height: size,
                background: color,
                boxShadow: `0 0 ${lvl === "crit" ? 10 : 5}px ${color}`,
                animation: `live-pulse ${1.4 + i * 0.2}s infinite`,
              }}
            />
          );
        })}
        <Aperture size={64} spin />
      </div>
    </div>
  );
}

interface HeroProps {
  ofts: MantleOft[] | null;
  status: SentinelStatus | null;
  onSentinel: () => void;
  onFleet: () => void;
}

function HeroSection({ ofts, status, onSentinel, onFleet }: HeroProps) {
  const totalVol = ofts?.reduce((s, o) => s + o.usdVolume, 0) ?? 0;
  const oftsWatched = status?.watched.length ?? ofts?.length ?? 0;
  const criticals = status?.watched.filter(w => w.assessment?.riskLevel === "CRITICAL").length ?? 0;
  const lastPollMs = status?.watched.reduce((m, w) => Math.max(m, w.lastSnapshotAt ?? 0), 0) ?? 0;

  // tick "last poll" every second via DOM — no re-render
  const lastPollRef = useRef(lastPollMs);
  lastPollRef.current = lastPollMs;
  useEffect(() => {
    const id = setInterval(() => {
      const el = document.getElementById("s-last");
      if (el) el.textContent = lastPollRef.current ? ago(lastPollRef.current) : "-";
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const animVol = useCountUp(totalVol / 1e9, 1400);
  const animOfts = useCountUp(oftsWatched, 1200);
  const animCrit = useCountUp(criticals, 1000);

  return (
    <div className="hero">
      <div className="hero-copy">
        <span className="kicker">
          <span className="live-dot" style={{ background: "var(--critical)", boxShadow: "0 0 8px var(--critical)" }} />
          APRIL 2026 · $292,000,000 DRAINED IN 80 MINUTES
        </span>
        <h1>
          The bridge hack<br />
          that <span className="grad">an agent</span><br />
          would have caught.
        </h1>
        <p className="lede">
          Kelp's rsETH bridge used a <b>single security checker</b>. One node was compromised.
          $292M left in 80 minutes. <b>OFT Sentinel</b> watches every cross-chain bridge on Mantle
          and writes on-chain proof the moment one becomes exploitable.
        </p>
        <div className="cta-row">
          <button className="btn btn-primary" onClick={onSentinel}>
            Open the live Sentinel →
          </button>
          <button className="btn btn-ghost" onClick={onFleet}>
            See the fleet
          </button>
        </div>
        <div className="live-strip">
          <div className="stat">
            <div className="v tnum" id="s-vol">
              {ofts ? `$${animVol.toFixed(1)}B` : "-"}
            </div>
            <div className="l">MONITORED VOLUME</div>
          </div>
          <div className="stat">
            <div className="v tnum" id="s-ofts">{oftsWatched || "-"}</div>
            <div className="l">OFTs WATCHED</div>
          </div>
          <div className="stat">
            <div className="v tnum" id="s-crit" style={{ color: "var(--critical)" }}>
              {status ? String(criticals) : "-"}
            </div>
            <div className="l">CRITICAL NOW</div>
          </div>
          <div className="stat">
            <div className="v tnum" id="s-last" style={{ color: "var(--scan)" }}>
              {lastPollMs ? ago(lastPollMs) : "-"}
            </div>
            <div className="l">LAST POLL</div>
          </div>
        </div>
      </div>
      <RadarCard />
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("app");
  const [runKelpOnOpen, setRunKelpOnOpen] = useState(false);
  const [ofts, setOfts] = useState<MantleOft[] | null>(null);
  const [status, setStatus] = useState<SentinelStatus | null>(null);
  const [oftsError, setOftsError] = useState("");

  useEffect(() => {
    getMantleOfts()
      .then(r => setOfts(r.ofts))
      .catch(e => setOftsError(e.message));
    getSentinelStatus()
      .then(setStatus)
      .catch(() => {}); // silent fail if backend is not running
  }, []);

  function openSentinel(kelp = false) {
    setRunKelpOnOpen(kelp);
    setView("sentinel");
    window.scrollTo(0, 0);
  }

  function scrollToFleet() {
    const el = document.getElementById("boardSec");
    if (el) window.scrollTo({ top: el.offsetTop - 70, behavior: "smooth" });
  }

  if (view === "story") return <Storyboard onClose={() => setView("app")} />;

  if (view === "sentinel") {
    return (
      <div className="app">
        <Header view="sentinel" onNav={v => { setView(v as View); window.scrollTo(0, 0); }} />
        <SentinelDashboard runKelpOnMount={runKelpOnOpen} onKelpConsumed={() => setRunKelpOnOpen(false)} />
      </div>
    );
  }

  return (
    <div className="app">
      <Header view="app" onNav={v => { setView(v as View); window.scrollTo(0, 0); }} />

      <section id="view-home" className="view on">
        <div className="page">
          <HeroSection
            ofts={ofts}
            status={status}
            onSentinel={() => openSentinel(false)}
            onFleet={scrollToFleet}
          />

          <div className="props">
            <div className="prop">
              <div className="ic">📡</div>
              <h3>Live monitoring</h3>
              <p>
                Every{" "}
                <span className="tip">
                  OFT
                  <span className="tipbox"><b>OFT</b>: a token that can move across multiple blockchains via LayerZero.</span>
                </span>
                {" "}on Mantle, re-checked every 5 minutes. The agent reads each bridge's live on-chain config and looks for dangerous drift.
              </p>
              <div className="metric">
                {status ? `${status.watched.length} OFTs` : "28 OFTs"} · every 5 min
              </div>
            </div>
            <div className="prop">
              <div className="ic">⛓️</div>
              <h3>On-chain proof</h3>
              <p>
                Every verdict is an{" "}
                <span className="tip">
                  attestation
                  <span className="tipbox"><b>Attestation</b>: a cryptographic receipt written permanently to the blockchain.</span>
                </span>
                {" "}written to a smart contract on Mantle, a permanent verifiable record anyone can audit.
              </p>
              <div className="metric">AuditRegistry · Mantle Sepolia</div>
            </div>
            <div className="prop">
              <div className="ic">📄</div>
              <h3>AI security reports</h3>
              <p>
                Download a full, plain-language audit for any bridge: an AI-written narrative plus deterministic{" "}
                <span className="tip">
                  DVN
                  <span className="tipbox"><b>DVN</b>: the security checker that verifies each cross-chain message is real.</span>
                </span>
                {" "}tables. Free, instant.
              </p>
              <div className="metric">DeepSeek narrative + config tables</div>
            </div>
          </div>

          <FlowAnimation />

          <div className="sec-title" id="boardSec">
            <h2>Mantle OFT leaderboard</h2>
            <div className="meta">SORTED BY VOLUME · LIVE SENTINEL STATUS</div>
          </div>

          <MantleBoard
            ofts={ofts}
            error={oftsError}
            status={status?.watched}
            onPick={() => openSentinel(false)}
          />

          <div className="cta-band">
            <div>
              <h2>Watch the agent catch Kelp, live.</h2>
              <p>
                Replay the exact configuration drift that drained $292M, and watch Sentinel detect it and
                write proof on-chain in real time.
              </p>
            </div>
            <button className="btn btn-danger" onClick={() => openSentinel(true)}>
              ▶ Run the Kelp replay
            </button>
          </div>

          <footer className="foot">
            <div>OFT Sentinel · Autonomous security for LayerZero on Mantle</div>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <button
                onClick={() => setView("story")}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--faint)", fontSize: 12.5, fontFamily: "var(--mono)" }}
              >
                How it works ↗
              </button>
              <span>Mantle Turing Test · Phase 2 · 2026</span>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}

// ── Shared header ─────────────────────────────────────────────────────────────

function Header({ view, onNav }: { view: View; onNav: (v: string) => void }) {
  return (
    <header className="appbar">
      <div className="brand" onClick={() => onNav("app")} style={{ cursor: "pointer" }}>
        <Aperture size={26} spin />
        <span className="wm">
          <span className="lite">OFT</span> SENTINEL
        </span>
      </div>
      <nav className="nav">
        <button
          id="nav-home"
          className={view === "app" ? "on" : ""}
          onClick={() => onNav("app")}
        >
          Overview
        </button>
        <button
          id="nav-sentinel"
          className={view === "sentinel" ? "on" : ""}
          onClick={() => onNav("sentinel")}
        >
          Sentinel
        </button>
      </nav>
      <div className="spacer" />
      <div className="status-chip">
        <span className="live-dot" />
        <span id="hdrStatus">SENTINEL ACTIVE · 28 OFTs</span>
      </div>
      <button className="btn btn-primary btn-sm appbar-cta" onClick={() => onNav("sentinel")}>
        Open the Sentinel →
      </button>
      <button className="btn btn-ghost btn-sm appbar-kelp" onClick={() => onNav("sentinel")}>
        ▶ Kelp replay
      </button>
    </header>
  );
}
