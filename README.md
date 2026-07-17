# OFT Sentinel

<!-- 7-LINE SUMMARY -->
<!-- Public README for OFT Sentinel: what the product is and how to run it. -->
<!-- An always-on agent that monitors LayerZero OFT security configuration on Mantle. -->
<!-- Detects security-relevant configuration drift the moment it happens and alerts teams. -->
<!-- Writes immutable on-chain attestations; every verdict is reproducible (keccak256(pdr) == verdictHash). -->
<!-- Stack: TypeScript + Node/Express backend, React/Vite frontend, viem RPC reads, Hardhat contracts on Mantle. -->
<!-- MCP server in mcp/: six read+validate tools so agents can pre-flight OFT configs and verify attestations. -->
<!-- Freshness: 2026-07-17. -->

**Continuous trust-intelligence for omnichain assets on Mantle.**

OFT Sentinel is an always-on agent that reads the live LayerZero DVN configuration for every high-value OFT on Mantle, detects security-relevant changes the moment they happen, writes immutable on-chain attestations with a verifiable Policy Decision Record, and alerts teams before funds move.

It turns invisible trust assumptions into a **verifiable, machine-readable risk dataset** — a signal that is not visible in TVL, volume, or price, and that no block explorer indexes. Every verdict is reproducible: `keccak256(JSON.stringify(pdr)) == verdictHash`, on-chain.

Built for the **Mantle Turing Test Hackathon** (Phase 2, June 2026) — **Mirana Alpha & Data track (Path A: Data & Analytics)**.

---

## The Problem

On 18 April 2026, $292M drained from the Kelp bridge in 80 minutes. LayerZero worked as designed. The loss came from one configuration change: someone dropped the verifier set from two DVNs to one, and it sat in public on-chain state for two years with nobody watching. LayerZero makes cross-chain security configurable, and that flexibility is the point. A configuration can still drift toward danger after deployment, and a one-shot audit can't catch a change it never sees again. An always-on agent can.

**Configuration changes like that are rare — and rarity is exactly why the check must be automated.** Teams build process around what happens weekly; nobody stays vigilant for a once-in-two-years event. The one monitoring cycle that matters looks identical to the hundred thousand quiet ones before it. Only a machine is present for it. Hence Sentinel.

OFT Sentinel answers the question that audits cannot: **did this protocol's security assumptions change since the last time anyone looked?**

---

## Why It Matters — Market & Business

**The market has already priced this product.** Filling the rsETH hole took **DeFi United** — an Aave-led rescue across six protocols, a **~$314M war chest** — including **Mantle Treasury's commitment of up to 30,000 ETH** (MIP-34, the largest single loan in the rescue). Every contributor paid, after the fact and at crisis prices, for the *absence* of configuration monitoring. The pre-incident version of that protection costs a rounding error on any single contribution. Business potential for security tooling is usually a projection; here it is a ledger.

**A dataset nobody else has.** Every investor can see TVL, volume, and price. Sentinel surfaces what they can't: **whether the trust assumptions securing an omnichain asset are getting stronger or weaker over time.** This config data is read live from the LayerZero endpoint, per corridor, every five minutes — it is **not indexed on Dune, Nansen, or any block explorer.** Sentinel is the only source, and it identifies deteriorating security before it becomes visible in TVL, volume, or price.

**Who pays, and what they buy:**

| Customer | Pain | What they buy |
|---|---|---|
| OFT issuer teams (Ethena, USDT0, mETH / cmETH, Ondo) | One silent config change is an existential incident; post-Kelp every lister asks "who's watching your config?" | 5-min drift alerts + machine-readable remediation + a public "monitored by Sentinel" attestation trail |
| Protocol risk teams (lending, LRT, vaults) | Listed collateral degrades *after* the review | Continuous score feed + API to gate collateral |
| Funds & quant desks | Bridge risk is unpriced until it detonates | Drift events as risk alpha; the Mantle Security Index as a benchmark |

**Pricing.** Monitoring is priced as **the audit that never expires: ~$25–50K/yr per asset** — 365-day coverage of the layer a one-shot audit can't see, for a fraction of one audit's cost. The subscription is the wedge; the licensable on-chain risk dataset is the long-term business. Phase 1 is free while the public attestation track record accumulates — in a trust business, the ledger of verdicts *is* the moat.

**Scales without re-engineering.** Marginal cost per asset is a handful of RPC reads per cycle; the rule engine is deterministic and versioned, so coverage grows without LLM cost; **adding a chain is configuration, not code** — the engine already discovers and reads corridors across all ~170 LayerZero V2 EIDs. Attestations run on Mantle Sepolia today; **mainnet attestation contracts are the first post-hackathon milestone.**

---

## Live Demo

> **Frontend:** https://oft-sentinel.netlify.app
> **Backend API:** deployed on Railway

**Demo flow:**
1. Visit the frontend → see the live fleet: every ≥$1M-volume OFT on Mantle (USDT0, cmETH, rsETH, USDe, sUSDe, ENA, USDY, …) with its Mantle Security Index
2. Click **"Run Kelp Replay"** → Sentinel seeds a healthy 2-of-2 baseline, injects a 1-of-1 snapshot → CRITICAL verdict fires
3. Click the **`attest tx ↗`** link → see the real on-chain attestation on [sepolia.mantlescan.xyz](https://sepolia.mantlescan.xyz)
4. See the **Policy Decision Record** — `keccak256(JSON.stringify(pdr)) == verdictHash` — independently verifiable
5. See the **Remediation steps** with deterministic pre-flight predictions: `25/CRITICAL → 84/AT_RISK` if the missing DVN is restored (84, not 100 — the fix leaves a 2-of-2 config, which still carries a minimal-redundancy finding)
6. Click any OFT tile → per-corridor DVN configuration (USDT0 alone spans 20 corridors) + remediation steps with pre-flight scores
7. Open **Security Copilot** → ask "Which OFT would you attack first?" → DeepSeek answers from live fleet context
8. Click **↓** on any tile → download a full AI-written audit report

---

## Agent Access — the MCP Server (`mcp/`)

**The MCP that won't let an agent ship a Kelp.** Any MCP-capable agent (Claude Code, Claude Desktop, Cursor, …) can talk to Sentinel directly: read the watched fleet, pull a corridor's DVN config, **validate a proposed config against the same deterministic rule engine that produces the on-chain attestations — before deploying it** — and independently verify any attestation against the chain. There are **no write tools by design**: the server cannot deploy, sign, or bridge, and it never touches a private key.

### What it does — six read+validate tools

| Tool | What an agent gets |
|---|---|
| `list_fleet` | Every watched OFT with risk band + score; filter by chain or risk |
| `get_oft_config` | Per-corridor required/optional DVN sets with resolved operator names, thresholds, effective counts |
| `get_verdict` | Live score/risk/reasons/remediation + the last on-chain attested verdict |
| `get_drift_history` | When the config drifted and what was attested about it |
| `verify_attestation` | Recomputes `keccak256(PDR)` locally and compares it to the backend AND the on-chain AuditRegistry — trustless, does not assume the backend is honest |
| `validate_config` | Pre-flight a config against the rule engine; answers with findings worst-first and an explicit **DO NOT SHIP** on CRITICAL (a 1-of-1 DVN route is how Kelp rsETH lost $292M) |

### Install

```bash
git clone https://github.com/damli40/oft-sentinel.git
cd oft-sentinel/mcp
npm ci && npm run build        # → dist/index.js (stdio server)
```

**Claude Code:**

```bash
claude mcp add oft-sentinel -- node /abs/path/to/oft-sentinel/mcp/dist/index.js
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oft-sentinel": {
      "command": "node",
      "args": ["/abs/path/to/oft-sentinel/mcp/dist/index.js"]
    }
  }
}
```

No API key needed — the server reads the public Sentinel API. Optional env: `SENTINEL_API_URL` (backend override), `SENTINEL_SEPOLIA_RPC` (RPC for the trustless attestation read; env-only on purpose so no agent can redirect it). Full details in [`mcp/README.md`](mcp/README.md).

Measured against live prod: `validate_config` answers in well under a second; `verify_attestation` takes ~3–4s because it genuinely round-trips Mantle Sepolia — that latency *is* the trustlessness.

---

## Deployed Contracts (Mantle Sepolia, chain ID 5003)

| Contract | Address |
|---|---|
| AuditRegistry | [`0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b`](https://sepolia.mantlescan.xyz/address/0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b) |
| AlertBus | [`0x350dc422bb2979684573409f229679fed383b2e5`](https://sepolia.mantlescan.xyz/address/0x350dc422bb2979684573409f229679fed383b2e5) |
| ERC-8004 IdentityRegistry (canonical) | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://sepolia.mantlescan.xyz/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |

**OFT Sentinel Agent ID: 120** — registered on the canonical ERC-8004 IdentityRegistry. Every `AuditRegistry.attest()` event embeds token ID 120 as the `agentId` field.

Deployer / Sentinel signer: `0xD618c61666d8848825E7e383c140eCd0Ad27e5aF`

---

## Architecture

```
Dune query 7638642
  ↓ all-time ≥$1M-volume V2 OFTs on Mantle mainnet
getWatched() — dynamic watch list (cached 10 min, deduped by address)

Every 5 minutes — pollOnce(), 3 OFTs concurrently:
  For each OFT:
    loadEidMap()        ← LZ deployments API (~170 V2 EVM EIDs, cached 24h)
    corridor discovery  ← ONE Etherscan getLogs call for PeerSet events
                          gives the exact EID set ever configured; each EID is
                          confirmed with a direct peers() read (Etherscan can
                          suggest corridors but never fabricate one).
                          Fallback: brute-force peers() sweep of all ~170 EIDs
                          (batched 25 concurrent) when Etherscan is unavailable.
    getConfig()         ← send-side ULN per active corridor
    getConfig()         ← same route on a secondary Mantle RPC
                          mismatch → route.rpcConflict (SOURCE_CONFLICT finding)
    getReceiveLibrary / getConfig on dst chain → receive-side ULN
    enforcedOptions() · owner() · EIP-1967 proxy admin slot
    → OftSnapshot

    Every read is resilient: primary RPC ×2 → mantle.drpc.org →
    mantle-rpc.publicnode.com → rpc.mantle.xyz → Etherscan v2 eth_call proxy
    (throttled to the free-tier 3/sec). A corridor that still can't be read
    becomes an UNKNOWN finding — flagged, never scored. A transient RPC
    failure must not masquerade as a security finding.

    assessSnapshot(snap) → { findings, score, riskLevel, tis, pdr }
    appendScoreHistory() → score-history.jsonl

  runCheck(baseline, observed):
    detectDrift() → DVN count drop / conf fall / lib→default / rpcConflict new?
      NO  → advance baseline silently
      YES → produceVerdict():
              assessSnapshot() → findings + score + riskLevel + tis
              buildPdr()       → PolicyDecisionRecord (canonical, minimal)
              verdictHash      = keccak256(JSON.stringify(pdr))
              AuditRegistry.attest(oft, 5000, verdictHash, score, risk, agentId=120)
                → post-state verify: re-reads total(), warns on mismatch
              AlertBus.alert() + Telegram (top-3 TIS remediations) / X (CRITICAL only)
              recordVerdict()  → sentinel-state.json (verdict includes pdr + tis)

Frontend polls /api/sentinel/status every 10s:
  assessment = assessSnapshot(currentSnapshot) — display-only, no on-chain action
  latestVerdict = last attested drift event ("Reset demo" hides prior DEMO
                  verdicts from the tile; the attestation ledger stays intact)
  msi = unweighted avg of all assessed scores

Three demo replays (synthetic DEMO OFT, real on-chain txs each time):
  POST /replay-kelp           → 2-of-2 → 1-of-1 DVN (Kelp rsETH pattern) → CRITICAL
  POST /replay-library-revert → receive library reverted to default → CRITICAL
  POST /replay-rpc-conflict   → secondary RPC disagrees on DVN config → SOURCE_CONFLICT
```

**No LLM in the security path.** Scoring, drift detection, verdicts, pre-flight predictions, and attestations are fully deterministic. DeepSeek powers only the copilot chat and report narrative, with deterministic fallbacks when no key is set.

---

## Scoring

Score starts at 100; deductions apply per finding (floor 0). The score is then clamped to the risk band, which is derived from the worst finding present.

| Severity | Deduction | Risk band effect |
|---|---|---|
| CRITICAL | −40 | risk = CRITICAL → score clamped ≤ 25 |
| HIGH | −20 | risk ≥ AT_RISK → score clamped ≤ 84 |
| MEDIUM | −10 | risk ≥ AT_RISK → score clamped ≤ 84 |
| LOW | −5 | advisory — deducts score, never flips the risk band |
| UNKNOWN | 0 | check could not be evaluated (e.g. corridor unreadable after every fallback) — flagged "(not scored)" |

### The checks (in evaluation order)

1. **RPC Source Conflict** (CRITICAL) — secondary RPC returns different DVN config; possible node manipulation
2. **ULN Unreadable** (UNKNOWN) — corridor config unreadable after all RPC + Etherscan fallbacks; surfaced, never scored
3. **DVN Count ≤ 1** (CRITICAL) — 1-of-1 effective DVN, the Kelp rsETH exploit pattern
4. **DVN Count = 2** (MEDIUM) — minimal redundancy; one failure blocks all messages
5. **Deprecated DVN** (CRITICAL) — deprecated DVN in required set; messages may permanently halt
6. **Self-DVN** (LOW) — protocol's own DVN in a 2-of-2 set reduces independent verifier count to one
7. **Cross-chain DVN Mismatch** (HIGH) — send DVN set ≠ receive DVN set; permanent message block
8. **Block Confirmations < 15** (MEDIUM) — re-org attack surface
9. **Enforced Options Missing** (LOW) — zero-gas messages can permanently stick nonces; emitted once fleet-wide (per-corridor stacking would let 20 LOWs outweigh a CRITICAL)
10. **Send Library Not Pinned** (HIGH) — the OFT uses the default send library; its admin can upgrade it and change outbound verification. Pinning a fixed library removes the dependency
11. **Receive Library Not Pinned** (CRITICAL) — the OFT uses the default receive library; its admin can upgrade it to change inbound acceptance rules independent of the DVN set. Pinning the receive library closes the gap
12. **Confirmation Mismatch** (HIGH) — send confs < receive required; permanent message block
13. **Owner Type: EOA** (HIGH) — single private key controls all OFT configuration
14. **Proxy Upgrade Control** (HIGH/MEDIUM) — implementation upgradeable by EOA (HIGH) or multisig (MEDIUM)
15. **Coverage** (MEDIUM) — every active corridor unreadable this cycle; prevents a blind poll from publishing a false 100/PASS

---

## Policy Decision Record (PDR)

Every on-chain attestation is backed by a PDR — a canonical, minimal record that makes the verdict independently verifiable:

```json
{
  "oft": "0x...",
  "chainId": 5000,
  "findings": [{ "severity": "CRITICAL", "check": "DVN Count", "detail": "..." }],
  "score": 25,
  "riskLevel": "CRITICAL",
  "evaluatedAt": 1780950909994,
  "agentId": 120,
  "rulesVersion": "1.0.0"
}
```

**`keccak256(JSON.stringify(pdr)) == verdictHash`** — stored with every verdict, shown in the dashboard, independently reproducible. This upgrades the attestation from "a verdict happened" to "here is exactly why, verifiably."

---

## Transaction Intent Schema (TIS)

Every verdict and standing assessment includes machine-readable remediation proposals:

```json
{
  "intent": "restore_dvn_redundancy",
  "action": "Add a second independent required DVN to the send configuration",
  "corridors": ["ethereum"],
  "dvnName": "LayerZero Labs",
  "currentState": "1 effective DVN — single point of failure",
  "targetState": "≥2 independent required DVNs per message path",
  "severity": "CRITICAL",
  "preflight": {
    "scoreBefore": 25, "riskBefore": "CRITICAL",
    "scoreAfter": 84,  "riskAfter": "AT_RISK"
  }
}
```

`preflight` simulates the **successor state** deterministically: it removes the findings the intent resolves, adds the findings the fixed config would still carry (fixing a 1-of-1 DVN yields a 2-of-2 — still a MEDIUM minimal-redundancy finding), then re-runs the same scoring + clamping engine. No fork, no extra RPC calls, no LLM — which is why the prediction above is 84, not a naive 100. Top 3 TIS entries appear in Telegram team alerts; top 5 render in the VerdictSpotlight and TokenOverlay.

---

## Key Features

| Feature | Description |
|---|---|
| **Live fleet monitoring** | Every all-time ≥$1M-volume OFT on Mantle (USDT0, cmETH, rsETH, USDe, sUSDe, ENA, USDY, …); watch list is dynamic from Dune |
| **Fast corridor discovery** | One Etherscan `PeerSet` getLogs call replaces a 170-EID brute-force sweep per OFT; every discovered corridor re-confirmed on-chain |
| **Read resilience** | Primary RPC ×2 → 3 fallback RPCs → Etherscan eth_call; unreadable ≠ insecure (UNKNOWN findings never deduct) |
| **Kelp replay** | Reproduces the $292M exploit pattern; fires real `attest()` + `alert()` txs on Mantle Sepolia |
| **Library-revert replay** | Receive library reverted to default → CRITICAL; second distinct exploit vector demo |
| **RPC conflict replay** | Secondary RPC disagrees on DVN config → SOURCE_CONFLICT CRITICAL; proves Sentinel can't be blinded by one RPC |
| **Policy Decision Record** | `keccak256(JSON.stringify(pdr)) == verdictHash` — on-chain attestations independently verifiable |
| **Pre-flight simulation** | Deterministic successor-state prediction per remediation: `scoreBefore/riskBefore → scoreAfter/riskAfter` |
| **DVN Concentration Panel** | Identifies systemic risk (one DVN provider securing most of Mantle's OFT TVL) |
| **Security Copilot** | DeepSeek-backed chat with full fleet context; 5 pre-staged questions + free text |
| **AI audit reports** | Per-OFT markdown: deterministic findings + corridor DVN config + LLM narrative + trust assumptions |
| **Intelligence Feed** | Live security event stream (drift, attest, poll) with relative timestamps |
| **Telegram alerts** | Live public channel `@oft_sentinel_watcher`; team DMs per OFT via `TELEGRAM_TEAM_ALERTS_JSON` |
| **Score history** | Time-series score per OFT written to JSONL on every poll cycle |
| **ERC-8004 identity** | Sentinel registered as Agent ID 120 on canonical IdentityRegistry |

---

## API Reference

All endpoints are on the backend (default port 3001).

### Sentinel endpoints (`/api/sentinel`)

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Fleet status: all watched OFTs with `assessment` (score, riskLevel, reasons, tis with preflight), `latestVerdict` (includes pdr + tis), `msi`, `msiBreakdown`, `dvnSummary`, `dvnNames` |
| GET | `/verdicts` | Full attestation history; each verdict includes `pdr` and `tis` |
| POST | `/validate` | Rule engine as a pure function: `{snapshot, ticker?, custodyDeclaration?}` → `{score, riskLevel, findings, tis, rulesVersion}` — no attestation, no alerts, no state (powers the MCP `validate_config` tool) |
| POST | `/poll` | Run one fleet poll across all watched OFTs immediately |
| POST | `/replay-kelp` | Kelp demo: 1-of-1 DVN drift → real attest + alert tx on DEMO |
| POST | `/replay-library-revert` | Receive library reverted to default → CRITICAL on DEMO |
| POST | `/replay-rpc-conflict` | Secondary RPC disagrees on DVN config → SOURCE_CONFLICT CRITICAL on DEMO |
| POST | `/reset-demo` | Re-seed DEMO's healthy baseline; hides prior replay verdicts from the tile (ledger + on-chain txs stay intact) |
| GET | `/history/:address` | Score history for one OFT: `[{score, riskLevel, capturedAt}]` |
| GET | `/feed` | Last 40 time-ordered security events across the fleet |
| POST | `/ask` | Security Copilot: `{question}` → DeepSeek with fleet context → `{answer, relevantOfts[]}` |
| GET | `/report/:address` | AI-written markdown audit report (cached by snapshot timestamp) |

### Mantle endpoints (`/api/mantle`)

| Method | Path | Description |
|---|---|---|
| GET | `/ofts` | Dune OFT leaderboard (query 7638642); `?refresh=true` busts the 10-min cache |

---

## Run It Locally

**Prerequisites:** Node 20+. Every API key is free-tier.

```bash
git clone https://github.com/damli40/oft-sentinel.git
cd oft-sentinel

cp .env.example .env   # backend/.env symlinks to this file
```

Fill in `.env` — the Sentinel degrades gracefully, so bring the keys you have:

| Key | Without it | Get it |
|---|---|---|
| `DUNE_API_KEY` | No live watch list — only the synthetic DEMO OFT appears | [dune.com/settings/api](https://dune.com/settings/api) |
| `SENTINEL_PRIVATE_KEY` | Verdicts still fire, but no on-chain `attest()`/`alert()` txs | Any key + test MNT from [faucet.sepolia.mantle.xyz](https://faucet.sepolia.mantle.xyz) |
| `ETHERSCAN_API_KEY` | Corridor discovery falls back to brute-forcing ~170 EIDs per OFT (slower, heavier on public RPCs); no last-resort read fallback | [etherscan.io/apis](https://etherscan.io/apis) |
| `DEEPSEEK_API_KEY` | Copilot + report narrative use deterministic fallback text | [platform.deepseek.com](https://platform.deepseek.com) |
| `TELEGRAM_*` | No Telegram alerts | optional |

```bash
# Install
cd backend && npm install
cd ../frontend && npm install
cd ..

# Terminal 1 — backend (port 3001; first fleet poll completes in ~60–90s)
cd backend && npm run dev

# Terminal 2 — frontend (port 5173; dev server proxies /api to :3001)
cd frontend && npm run dev
```

Open http://localhost:5173.

For a clean slate (baselines re-capture on the first poll):
```bash
rm -f backend/data/sentinel-state.json backend/data/score-history.jsonl
```

**Smoke test:**
```bash
# Health
curl localhost:3001/api/health

# Fleet status (after first poll completes)
curl localhost:3001/api/sentinel/status | jq '.watched[] | {ticker, score: .assessment.score, risk: .assessment.riskLevel}'

# Kelp replay — fires a real on-chain attest + alert tx (needs SENTINEL_PRIVATE_KEY)
curl -X POST localhost:3001/api/sentinel/replay-kelp

# Verify the PDR hash matches the on-chain verdictHash:
# response includes pdr + verdictHash; keccak256(JSON.stringify(pdr)) == verdictHash
```

**Backend tests:**
```bash
cd backend && npm test   # 32 tests: scoring, drift detection, preflight, decoders
```

---

## Production Deployment

### Backend → Railway

1. Create a Railway project, connect the `backend/` directory
2. Add a **persistent volume** at `/data` (preserves `sentinel-state.json` + `score-history.jsonl` across restarts)
3. Set environment variables: everything from `.env.example`, plus

```
DATA_DIR=/data
NODE_ENV=production
CORS_ORIGINS=https://your-frontend.netlify.app
```

4. Start command: `npm start` (configured in `railway.toml`)

### Frontend → Netlify

1. Connect the `frontend/` directory (base dir: `frontend`)
2. Build command: `npm run build` / publish directory: `dist` (configured in `netlify.toml`)
3. Set env var: `VITE_API_URL=https://<your-railway-service>.up.railway.app`

**Smoke test after deploy:** run the Kelp replay from the deployed frontend → verify the `attest tx ↗` link opens a real tx on sepolia.mantlescan.xyz.

---

## Contract Tests & Deployment

```bash
cd contracts && npm install && npm test
# 13/13 passing (AuditRegistry + AlertBus)
```

To deploy your own registry to Mantle Sepolia:
```bash
cd contracts
cp .env.example .env   # DEPLOYER_PRIVATE_KEY funded with test MNT
npm run deploy:testnet
npx hardhat verify --network mantleSepolia <address>
```

Then point the backend at your addresses via `AUDIT_REGISTRY_ADDRESS` / `ALERT_BUS_ADDRESS`.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node 20 + Express + viem (ESM, TypeScript strict) |
| Frontend | React 18 + Vite + Tailwind (custom CSS, no component library) |
| Contracts | Hardhat 2 + hardhat-toolbox-viem (Solidity 0.8.27) |
| AI (reports + copilot) | DeepSeek — not in the security path; deterministic fallback if key unset |
| On-chain data | viem — direct reads of the LZ endpoint (`0x1a44…728c`) on Mantle mainnet, multi-RPC fallback |
| Corridor discovery | Etherscan v2 `getLogs` (PeerSet events) with on-chain confirmation; brute-force sweep fallback |
| Off-chain data | Dune Analytics — OFT volume leaderboard (query 7638642) |
| Alerts | Telegram Bot API + AlertBus on-chain MNT nudge |
| Chain (monitoring) | Mantle mainnet (5000, LayerZero EID 30181) |
| Chain (attestations) | Mantle Sepolia (5003) |
| Agent identity | ERC-8004 canonical IdentityRegistry (`0x8004…BD9e`) |

---

## Changelog

- **2026-06-12** — More mobile fixes: the token modal's close ✕ no longer clips off-screen after scrolling (panel uses dynamic viewport height `dvh` + locks page scroll while open), and the OFT/DVN explainer tooltips on the home page no longer overflow the screen edge (left-anchored + width-capped).
- **2026-06-12** — Mobile UX: tapping "Open Sentinel" / "Kelp replay" no longer jump-scrolls the page (the live intel feed now scrolls within its own box, and the view opens at the top); leaderboard rows no longer navigate on tap (only the explicit buttons do), preventing accidental view-switches while scrolling on a phone. Fleet tiles stay tappable to open a bridge's detail modal.
- **2026-06-12** — Mobile fixes: the token modal's close ✕ is now pinned and always reachable on phones (sticky header; the full contract address no longer pushes it off-screen), and the Mantle leaderboard columns realign on mobile (the `Address` header now hides together with its cell). Desktop unchanged. Verified at 390px.

---

## Judging Criteria — Quick Reference

**Part A — Mantle general**

| Dimension | How OFT Sentinel answers it |
|---|---|
| **Technical** | Live viem reads of the LZ endpoint on Mantle mainnet with a multi-RPC quorum (one bad node can't blind it); deterministic 15-check engine; verdicts attested on-chain with a recomputable hash; 32 backend + 13 contract tests; contracts verified on Mantlescan |
| **Ecosystem fit** | Monitors the entire live Mantle OFT fleet (every all-time ≥$1M-volume V2 OFT, $13.8B+ cross-chain volume) reading Mantle-native LZ config; strengthens the asset layer Mantle is courting (stablecoins, RWAs, LRTs) |
| **Business potential** | Realized willingness-to-pay (~$314M DeFi United, Mantle's 30K ETH); priced ~$25–50K/yr per asset ("the audit that never expires") with a licensable-dataset expansion; named customer segments (see *Why It Matters*) |
| **Innovation** | A new data category — trust-assumption drift — that audits and explorers structurally cannot see; reproducible because no LLM decides the verdict |
| **User experience** | Zero signup, zero gas to view; replay-first front door; plain-English Security Copilot explains any score |

**Part B — Mirana Alpha & Data (Path A: Data & Analytics)**

| Dimension | How OFT Sentinel answers it |
|---|---|
| **Insight value** | Surfaces whether the trust assumptions securing an asset are strengthening or weakening over time — actionable, comprehensible, and not derivable from TVL/volume/price |
| **Data source quality** | Read live from the LayerZero endpoint per corridor, multi-RPC, every 5 min, across the whole Mantle fleet; Mantle-native and **not indexed on Dune, Nansen, or any explorer** |
| **Investment utility** | A lending protocol gates collateral on it; a fund reads drift events as risk alpha; an issuer proves it's monitored — all backed by a recomputable on-chain record a professional can audit |
| **Scalability & sustainability** | Near-zero marginal cost per asset; deterministic versioned engine; adding a chain is config, not code; pipeline stays live on a paid RPC tier at first revenue; generalizes to all ~170 LZ V2 EIDs (LSIN) |

**Verifiability throughout:** every attestation carries `keccak256(JSON.stringify(pdr)) == verdictHash` — reproducible, not claimed.

---

## Post-Hackathon: LayerZero Security Intelligence Network (LSIN)

OFT Sentinel is LSIN v0: Mantle-focused, OFT-scoped. The architecture generalizes to every LayerZero V2 OApp across all ~170 EVM EIDs — the detection engine already discovers and reads corridors on all of them.

**Vision:** Become the canonical security monitoring layer for the entire LayerZero ecosystem — "CrowdStrike for LayerZero applications." LSIN continuously observes trust assumptions, detects security-relevant configuration changes, assesses impact, alerts stakeholders, and produces immutable attestations.

**Three layers:**
1. **Detection** — continuous config polling with multi-RPC quorum, event-log corridor discovery, baseline diffing, 15-check rule engine
2. **Intelligence** — deterministic findings + TIS remediations + successor-state pre-flight simulation + LLM narrative
3. **Attestation** — tamper-resistant on-chain record per event with PDR hash + ERC-8004 agent provenance
