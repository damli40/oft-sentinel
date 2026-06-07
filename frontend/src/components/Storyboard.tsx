import { useEffect, useRef } from "react";
import "../storyboard.css";

export function Storyboard({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    // reveal on scroll
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add("show"); }),
      { threshold: 0.18, root }
    );
    root.querySelectorAll(".reveal").forEach((el) => io.observe(el));

    // $292M counter
    const counter = root.querySelector<HTMLElement>("#sb-counter");
    let counted = false;
    const cio = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting && !counted && counter) {
          counted = true;
          const target = Number(counter.dataset.target || "0");
          let n = 0;
          const step = () => {
            n += Math.ceil(target / 45);
            if (n >= target) n = target; else requestAnimationFrame(step);
            counter.textContent = "$" + n + "M";
          };
          step();
        }
      }),
      { threshold: 0.5, root }
    );
    if (counter) cio.observe(counter);

    // score rings
    const C = 402;
    const rio = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) {
          const safe = root.querySelector<SVGCircleElement>(".r-safe");
          const crit = root.querySelector<SVGCircleElement>(".r-crit");
          if (safe) safe.style.strokeDashoffset = String(C * (1 - 92 / 100));
          if (crit) crit.style.strokeDashoffset = String(C * (1 - 28 / 100));
          rio.disconnect();
        }
      }),
      { threshold: 0.4, root }
    );
    const replay = root.querySelector(".replay");
    if (replay) rio.observe(replay);

    // sparklines
    root.querySelectorAll<HTMLElement>(".spark").forEach((s) => {
      if (s.childElementCount) return; // guard against StrictMode double-run
      const vals = (s.dataset.spark || "").split(",").map(Number);
      const min = Math.min(...vals), max = Math.max(...vals);
      vals.forEach((v) => {
        const i = document.createElement("i");
        i.style.height = 6 + ((v - min) / (max - min || 1)) * 22 + "px";
        if (v < 50) i.style.background = "var(--red)";
        else if (v < 75) i.style.background = "var(--amber)";
        s.appendChild(i);
      });
    });

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { io.disconnect(); cio.disconnect(); rio.disconnect(); window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return (
    <div className="story" ref={ref}>
      <button className="sb-back" onClick={onClose}>← Back to app</button>

      {/* HERO */}
      <header className="hero">
        <div className="radar"><span></span><span></span><span></span></div>
        <div className="wrap">
          <div className="badge"><span className="dot"></span> Mantle Turing Test Hackathon 2026 · AI DevTools</div>
          <h1 className="grad">OFT Sentinel</h1>
          <p className="lead">An autonomous agent that watches LayerZero OFTs on Mantle. It catches the moment
            a token's security drops into a dangerous state, scores the new risk, and writes the verdict
            on-chain. The next <strong style={{ color: "var(--text)" }}>$292M exploit</strong> gets flagged
            <em> before</em> it drains.</p>
          <div className="statbar">
            <span><b>$13.7B</b> secured</span>
            <span><b>36</b> OFTs</span>
            <span><b>26</b> projects</span>
            <span><b>181,815</b> messages</span>
          </div>
        </div>
        <div className="scroll-hint">scroll ↓</div>
      </header>

      {/* PROBLEM */}
      <section>
        <div className="wrap reveal">
          <div className="num">01: THE PROBLEM</div>
          <h2>A redeployment weakened the bridge.</h2>
          <p className="lead">On 18 April 2026, attackers drained a LayerZero bridge. Someone had
            <strong style={{ color: "var(--text)" }}> redeployed the contract with a 1-of-1 DVN</strong>. A scan
            the day before would have passed it. The protocol did its job. The redeploy gutted the
            <em> trust assumption</em> behind it.</p>
          <div className="bignum" id="sb-counter" data-target="292">$0M</div>
          <div className="dvn-row">
            <div className="dvn">before: requiredDVNs [ A, B, C ] · 2-of-3</div>
            <div className="dvn bad">after redeploy: requiredDVNs [ LZ Labs ] · 1-of-1</div>
          </div>
          <p className="lead">You catch this one way: <strong style={{ color: "var(--text)" }}>watch the config the
            moment it changes</strong>. An always-on agent does that. A one-shot audit cannot.</p>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section>
        <div className="wrap reveal">
          <div className="num">02: THE AGENT</div>
          <h2>Autonomous spine. Multi-agent depth.</h2>
          <p className="lead">One sentinel loop runs around the clock. When a config drifts, it wakes a team
            of specialist subagents, runs the deep audit, and commits the result to Mantle.</p>

          <div className="pipe">
            <div className="node sentinel">
              <h3><span className="ico">📡</span> OFT Sentinel <span className="tag">always-on</span></h3>
              <p>Polls <code>peers()</code>, <code>getConfig()</code> &amp; <code>getReceiveLibrary()</code> on Mantle. Compares each read against the last safe snapshot.</p>
            </div>
            <div className="conn"></div>
            <div className="node alert">
              <h3><span className="ico">⚠️</span> Change detected <span className="tag" style={{ color: "var(--red)", borderColor: "var(--red)" }}>redeploy / setConfig → 1-of-1</span></h3>
              <p>A new deployment or config change dropped a required DVN. Risk just spiked. The orchestrator wakes the audit team.</p>
            </div>
            <div className="conn"></div>
            <div className="agents">
              <div className="agent"><div className="e">🔎</div><div className="n">Collector</div><div className="s">fetch config</div></div>
              <div className="agent"><div className="e">🧠</div><div className="n">DVN Analyst</div><div className="s">LZ V2 rules</div></div>
              <div className="agent"><div className="e">📊</div><div className="n">Scorer</div><div className="s">0–100</div></div>
              <div className="agent"><div className="e">✍️</div><div className="n">Attestor</div><div className="s">→ Mantle</div></div>
            </div>
            <div className="conn"></div>
            <div className="node attest">
              <h3><span className="ico">⛓️</span> AuditRegistry.attest() <span className="tag" style={{ color: "var(--blue)", borderColor: "var(--blue)" }}>on-chain</span></h3>
              <p>Verdict hash, score, risk, and ERC-8004 agent id, written to Mantle for good.</p>
            </div>
          </div>
        </div>
      </section>

      {/* KELP REPLAY */}
      <section>
        <div className="wrap reveal">
          <div className="num">03: THE DEMO</div>
          <h2>The Kelp replay.</h2>
          <p className="lead">We rebuild the exact config drift on-chain and run the Sentinel against it.
            It re-scores in seconds and flips the verdict to CRITICAL. That is the alert that never fired.</p>

          <div className="replay">
            <div>
              <div className="ring">
                <svg width="150" height="150" viewBox="0 0 150 150">
                  <circle cx="75" cy="75" r="64" fill="none" stroke="#1E2028" strokeWidth="12" />
                  <circle className="r-safe" cx="75" cy="75" r="64" fill="none" stroke="#2BD576" strokeWidth="12"
                    strokeLinecap="round" strokeDasharray="402" strokeDashoffset="402" />
                </svg>
                <div className="val" style={{ color: "var(--green)" }}>92</div>
              </div>
              <div className="cap">2-of-3 DVN · hardened</div>
              <div className="pill safe">SAFE</div>
            </div>
            <div className="arrow">→</div>
            <div>
              <div className="ring">
                <svg width="150" height="150" viewBox="0 0 150 150">
                  <circle cx="75" cy="75" r="64" fill="none" stroke="#1E2028" strokeWidth="12" />
                  <circle className="r-crit" cx="75" cy="75" r="64" fill="none" stroke="#FF4D5E" strokeWidth="12"
                    strokeLinecap="round" strokeDasharray="402" strokeDashoffset="402" />
                </svg>
                <div className="val" style={{ color: "var(--red)" }}>28</div>
              </div>
              <div className="cap">1-of-1 DVN · the Kelp pattern</div>
              <div className="pill crit">CRITICAL, alert fired</div>
            </div>
          </div>
        </div>
      </section>

      {/* DASHBOARD */}
      <section>
        <div className="wrap reveal">
          <div className="num">04: THE PRODUCT</div>
          <h2>A live board of Mantle's cross-chain assets.</h2>
          <p className="lead">Every OFT it watches, with a current trust score, live status, and a 30-day risk
            trail. Volume and message counts come straight from LayerZero data on Dune. Today that's
            <strong style={{ color: "var(--text)" }}> $13.7B</strong> across 36 OFTs and 181,815 messages.</p>

          <div className="board">
            <div className="brow head"><div>OFT</div><div>Score</div><div>Status</div><div>30-day drift</div></div>
            <div className="brow">
              <div className="sym">mETH <small>0x4afa…e948 · Mantle</small></div>
              <div className="sc ok">91</div>
              <div><span className="st ok">● secure</span></div>
              <div className="spark" data-spark="90,91,91,92,90,91,91"></div>
            </div>
            <div className="brow">
              <div className="sym">cmETH <small>0xc144…dca9 · Mantle</small></div>
              <div className="sc warn">68</div>
              <div><span className="st warn">● at risk</span></div>
              <div className="spark" data-spark="85,84,80,72,70,68,68"></div>
            </div>
            <div className="brow">
              <div className="sym">USDY <small>0x…Ondo · Mantle RWA</small></div>
              <div className="sc ok">88</div>
              <div><span className="st ok">● secure</span></div>
              <div className="spark" data-spark="88,88,87,88,89,88,88"></div>
            </div>
            <div className="brow">
              <div className="sym">DEMO-OFT <small>replay · Kelp pattern</small></div>
              <div className="sc danger">28</div>
              <div><span className="st danger">● critical</span></div>
              <div className="spark" data-spark="92,92,90,55,40,30,28"></div>
            </div>
          </div>
        </div>
      </section>

      {/* ATTESTATION */}
      <section>
        <div className="wrap reveal">
          <div className="num">05: THE PROOF</div>
          <h2>Every verdict lands on Mantle.</h2>
          <p className="lead">The hackathon calls this on-chain benchmarking of AI. The agent hashes each
            report and writes the score on-chain, so anyone can pull a verdict and confirm the report
            still matches.</p>

          <div className="block">
            <div className="line"><span className="k">contract</span><span className="v">AuditRegistry · Mantle</span></div>
            <div className="line"><span className="k">event</span><span className="v">Attested(id: 1042)</span></div>
            <div className="line"><span className="k">oft</span><span className="v">0xc144…dca9</span></div>
            <div className="line"><span className="k">chainId</span><span className="v">5000</span></div>
            <div className="line"><span className="k">score / risk</span><span className="v">28 · CRITICAL</span></div>
            <div className="line"><span className="k">verdictHash</span><span className="v">0x9f3a…e21b</span></div>
            <div className="line"><span className="k">agentId (ERC-8004)</span><span className="v">#7</span></div>
            <div className="line"><span className="k">timestamp</span><span className="v">block 12,884,301</span></div>
          </div>

          <div className="chips">
            <div className="chip">🎯 <b>AI DevTools</b>, primary</div>
            <div className="chip">📈 <b>Alpha &amp; Data</b>, parallel</div>
            <div className="chip">🏆 <b>Grand Champion</b>, nominate</div>
            <div className="chip">📦 <b>Deployment Award</b>, floor</div>
            <div className="chip">🎨 <b>Best UI/UX</b></div>
          </div>
        </div>
      </section>

      {/* ALERT */}
      <section>
        <div className="wrap reveal">
          <div className="num">06: THE ALERT</div>
          <h2>The right people, the right loudness.</h2>
          <p className="lead">A fixable issue gets a quiet nudge. A Kelp-grade redeploy trips every alarm. The
            agent escalates by severity, so it stays quiet until the danger earns the noise.</p>

          <div className="esc">
            <div className="tier warn">
              <span className="lvl">AT RISK</span>
              <span>→ private: <strong style={{ color: "var(--text)" }}>MNT nudge to the owner wallet</strong> + Telegram/Discord</span>
            </div>
            <div className="tier crit">
              <span className="lvl">CRITICAL</span>
              <span>→ all of the above <strong style={{ color: "var(--text)" }}>+ public X broadcast</strong></span>
            </div>
          </div>

          <div className="chan-label">① ON-CHAIN · AlertBus → OFT owner wallet</div>
          <div className="block">
            <div className="line"><span className="k">call</span><span className="v">AlertBus.alert(oft, owner, 28, uri)</span></div>
            <div className="line"><span className="k">to (owner, from owner())</span><span className="v">0x9a3f…D1c0</span></div>
            <div className="line"><span className="k">value</span><span className="mnt-tag">+ 0.001 MNT  ← the nudge</span></div>
            <div className="line"><span className="k">event</span><span className="v">Alert(owner, oft=0xc144…dca9, 28, uri)</span></div>
            <div className="line"><span className="k">verdictURI</span><span className="v">AuditRegistry · attest #1042</span></div>
          </div>

          <div className="chan-label">② TELEGRAM / DISCORD · security channel</div>
          <div className="tg">
            <div className="hd"><span className="av">🛰️</span> OFT Sentinel</div>
            <div className="body">
              🚨 <b className="crit">CRITICAL</b>: <b>cmETH</b> <span className="m">(0xc144…dca9) · Mantle</span><br />
              <span className="m">Config changed:</span> requiredDVNs <b>2-of-3 → 1-of-1</b><br />
              <span className="m">Trust score</span> 92 → <b className="crit">28</b><br />
              <span className="m">Owner notified on-chain · verdict</span> <span className="link">↗ mantlescan/tx/0x…</span>
            </div>
          </div>

          <div className="chan-label">③ PUBLIC X · critical only</div>
          <div className="tweet">
            <div className="top"><div className="av2"></div>
              <div><div className="nm">OFT Sentinel</div><div className="hn">@oft_sentinel · now</div></div>
            </div>
            <div className="txt">⚠️ <b className="crit">CRITICAL:</b> the <b>cmETH</b> OFT on @0xMantle was just reconfigured
              to a <b>1-of-1 DVN</b>, the same trust-assumption downgrade that drained <b>$292M</b> from Kelp.
              Owner notified on-chain. Verdict recorded on Mantle ↗ <span className="link">mantlescan.xyz</span>
              <br />#MantleAIHackathon</div>
            <div className="mta">12:04 · autonomous post · verdict #1042</div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          OFT Sentinel: autonomous OFT security for the Mantle ecosystem ·{" "}
          <a href="https://x.com/rookie_of_Ph" target="_blank" rel="noreferrer">@rookie_of_Ph</a><br />
          <span style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>#MantleAIHackathon · deadline 2026-06-15</span>
        </div>
      </footer>
    </div>
  );
}
