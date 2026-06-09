# OFT Sentinel

**Autonomous security monitoring for LayerZero OFTs on Mantle.**

OFT Sentinel is an always-on agent that reads the live LayerZero DVN configuration for every major OFT on Mantle, detects security-relevant changes the moment they happen, writes immutable on-chain attestations with a verifiable Policy Decision Record, and alerts teams before funds move.

Built for the **Mantle Turing Test Hackathon** (Phase 2, June 2026). Tracks: AI DevTools + Alpha & Data.

---

## The Problem

On 18 April 2026, attackers drained $292M from a LayerZero bridge in 80 minutes. The exploit vector: a single configuration change — one DVN dropped from two to one — that no monitoring system caught. A one-shot audit cannot catch a change it never sees again. An always-on agent can.

OFT Sentinel answers the question that audits cannot: **did this protocol's security assumptions change since the last time anyone looked?**

---

## Live Demo

> **Frontend:** https://oft-sentinel.netlify.app
> **Backend API:** deployed on Railway

**Demo flow:**
1. Visit the frontend → see the live fleet: 28 OFTs monitored, 5 CRITICAL right now
2. Click **"Run Kelp Replay"** → Sentinel seeds a healthy 2-of-2 baseline, injects a 1-of-1 snapshot → CRITICAL verdict fires
3. Click the **`attest tx ↗`** link → see the real on-chain attestation on [sepolia.mantlescan.xyz](https://sepolia.mantlescan.xyz)
4. See the **Policy Decision Record** — `keccak256(JSON.stringify(PDR)) == verdictHash` — independently verifiable
5. See the **Remediation steps** with pre-flight predictions: `CRITICAL → 65/AT_RISK` if the DVN is restored
6. Click any OFT tile → DVN configuration + remediation steps with pre-flight scores
7. Open **Security Copilot** → ask "Which OFT would you attack first?" → DeepSeek answers from live fleet context
8. Click **↓** on any tile → download a full AI-written audit report

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
Dune query 7664779
  ↓ 7-day active V2 OFTs on Mantle mainnet (28 addresses)
getWatched() — dynamic watch list (cached 10 min)

Every 5 minutes — pollOnce() with concurrency 6:
  For each OFT:
    loadEidMap()      ← LZ deployments API (170 EIDs, cached 24h)
    peers() sweep     ← batched 25 concurrent to bound RPC load
    getConfig()       ← send-side ULN per active corridor (primary RPC)
    getConfig()       ← same route on secondary RPC (mantle.drpc.org)
      mismatch → route.rpcConflict = true (SOURCE_CONFLICT finding)
    getReceiveLibrary / getConfig on dst chain → receive-side ULN
    getEnforcedOptions() · owner() · EIP-1967 proxy admin slot
    → OftSnapshot

    assessSnapshot(snap) → { findings, score, riskLevel, tis, pdr }
    appendScoreHistory() → score-history.jsonl

  runCheck(baseline, observed):
    detectDrift() → DVN count drop / conf fall / lib→default / rpcConflict newly appearing?
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
  latestVerdict = last attested drift event
  msi = unweighted avg of all assessed scores

Three demo replays (synthetic DEMO OFT, real on-chain txs each time):
  POST /replay-kelp          → 2-of-2 → 1-of-1 DVN (Kelp rsETH pattern) → CRITICAL
  POST /replay-library-revert → receive library reverted to default → CRITICAL
  POST /replay-rpc-conflict  → secondary RPC disagrees on DVN config → SOURCE_CONFLICT CRITICAL
```

---

## Scoring

Score starts at 100; deductions are applied per finding (floor 0). Score is then clamped to the `AuditRegistry` risk bands.

| Severity | Deduction | Clamp |
|---|---|---|
| CRITICAL | −40 | Score capped at 25 |
| HIGH | −20 | Score capped at 84 |
| MEDIUM | −10 | |
| LOW | −5 | |

### 14 checks (in evaluation order)

1. **RPC Source Conflict** (CRITICAL) — secondary RPC returns different DVN config; possible node manipulation
2. **DVN Count ≤ 1** (CRITICAL) — 1-of-1 effective DVN, the Kelp rsETH exploit pattern
3. **DVN Count = 2** (MEDIUM) — minimal redundancy; one failure blocks all messages
4. **Deprecated DVN** (CRITICAL) — deprecated DVN in required set; messages may permanently halt
5. **Self-DVN** (LOW) — protocol's own DVN in a 2-of-2 set reduces independent verifier count to one
6. **Cross-chain DVN Mismatch** (HIGH) — send DVN names ≠ receive DVN names; permanent message block
7. **Block Confirmations < 15** (MEDIUM) — re-org attack surface
8. **Enforced Options Missing** (LOW) — zero-gas messages can permanently stuck nonces
9. **Send Library Not Pinned** (HIGH) — LZ Labs OneSig (3-of-5 EOAs) can redirect outbound verification
10. **Receive Library Not Pinned** (CRITICAL) — LZ Labs can change inbound acceptance rules, bypassing DVN config
11. **Confirmation Mismatch** (HIGH) — send confs < receive required; permanent message block
12. **EOA Owner** (HIGH) — single private key controls all OFT configuration
13. **Proxy Upgrade by EOA** (HIGH) — single key can upgrade the implementation
14. **Proxy Upgrade by Multisig** (MEDIUM) — noted; better than EOA but not trustless

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
    "scoreAfter": 65,  "riskAfter": "AT_RISK"
  }
}
```

`preflight` shows the predicted score/risk if that single finding were resolved — no fork or extra RPC calls needed (pure deduction reversal). Top 3 TIS entries appear in Telegram team alerts. Top 5 render in the VerdictSpotlight and TokenOverlay.

---

## Key Features

| Feature | Description |
|---|---|
| **Live fleet monitoring** | 28 Mantle OFTs (cmETH, rsETH, USDe, sUSDe, USDT0, BOMB, BOX, COQ, and more); watch list is dynamic from Dune |
| **Kelp replay** | Reproduces the $292M exploit pattern; fires real `attest()` + `alert()` txs on Mantle Sepolia |
| **Library-revert replay** | Receive library reverted to default → CRITICAL; second distinct exploit vector demo |
| **RPC conflict replay** | Secondary RPC disagrees on DVN config → SOURCE_CONFLICT CRITICAL; proves Sentinel can't be blinded |
| **Policy Decision Record** | `keccak256(JSON.stringify(pdr)) == verdictHash` — on-chain attestations independently verifiable |
| **Pre-flight simulation** | Each TIS remediation shows `scoreBefore/riskBefore → scoreAfter/riskAfter` |
| **DVN Concentration Panel** | Identifies systemic risk (one DVN provider securing >60% of Mantle TVL) |
| **Security Copilot** | DeepSeek-backed chat with full fleet context; 5 pre-staged questions + free text |
| **AI audit reports** | Per-OFT markdown: deterministic findings + corridor DVN config + LLM narrative + trust assumptions |
| **Intelligence Feed** | Live security event stream (drift, attest, poll) with relative timestamps |
| **Telegram alerts** | Live public channel `@oft_sentinel_watcher`; team DMs per OFT via `TELEGRAM_TEAM_ALERTS_JSON` |
| **Score history** | Time-series MSI per OFT written to JSONL on every poll cycle |
| **ERC-8004 identity** | Sentinel registered as Agent ID 120 on canonical IdentityRegistry |

---

## API Reference

All endpoints are on the backend (default port 3001).

### Sentinel endpoints (`/api/sentinel`)

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Fleet status: all watched OFTs with `assessment` (score, riskLevel, reasons, tis with preflight), `latestVerdict` (includes pdr + tis), `msi`, `msiBreakdown`, `dvnSummary`, `dvnNames` |
| GET | `/verdicts` | Full attestation history; each verdict includes `pdr` and `tis` |
| POST | `/poll` | Run one fleet poll across all watched OFTs immediately |
| POST | `/replay-kelp` | Kelp demo: 1-of-1 DVN drift → real attest + alert tx on DEMO |
| POST | `/replay-library-revert` | Receive library reverted to default → CRITICAL on DEMO |
| POST | `/replay-rpc-conflict` | Secondary RPC disagrees on DVN config → SOURCE_CONFLICT CRITICAL on DEMO |
| GET | `/history/:address` | Score history for one OFT: `[{score, riskLevel, capturedAt}]` (last 200 entries) |
| GET | `/feed` | Last 40 time-ordered security events across the fleet |
| POST | `/ask` | Security Copilot: `{question}` → DeepSeek with fleet context → `{answer, relevantOfts[]}` |
| GET | `/report/:address` | AI-written markdown audit report (cached by snapshot timestamp) |

### Mantle endpoints (`/api/mantle`)

| Method | Path | Description |
|---|---|---|
| GET | `/ofts` | Dune OFT leaderboard (query 7664779, 7-day active OFTs); `?refresh=true` busts 10-min cache |

---

## Local Setup

**Prerequisites:** Node 20+, funded Mantle Sepolia key (faucet: https://faucet.sepolia.mantle.xyz)

```bash
git clone https://github.com/damli40/oft-sentinel.git
cd oft-sentinel

# Copy and fill env vars
cp .env.example .env
# Required: SENTINEL_PRIVATE_KEY, DUNE_API_KEY, DEEPSEEK_API_KEY
# Optional: TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID, TELEGRAM_TEAM_ALERTS_JSON

# Install all deps
cd backend && npm install
cd ../frontend && npm install
cd ..

# Start backend (port 3001)
cd backend && npm run dev

# Start frontend (port 5173) — in a new terminal
cd frontend && npm run dev
```

For a clean demo:
```bash
rm backend/data/sentinel-state.json backend/data/score-history.jsonl
# Restart backend — baselines re-capture on first poll (~60s)
```

**Smoke test:**
```bash
# Health
curl localhost:3001/api/health

# Fleet status (after first poll completes)
curl localhost:3001/api/sentinel/status | jq '.watched[0] | {ticker, assessment: .assessment | {score, riskLevel}}'

# Kelp replay — fires real on-chain attest + alert tx
curl -X POST localhost:3001/api/sentinel/replay-kelp

# Verify PDR hash matches on-chain verdictHash
# → response includes pdr + verdictHash; keccak256(JSON.stringify(pdr)) == verdictHash
```

---

## Production Deployment

### Backend → Railway

1. Create Railway project, connect `backend/` directory
2. Add a **persistent volume** at `/data` (preserves `sentinel-state.json` + `score-history.jsonl` across restarts)
3. Set environment variables:

```
DATA_DIR=/data
NODE_ENV=production
SENTINEL_PRIVATE_KEY=<funded Mantle Sepolia key>
SENTINEL_RPC=https://rpc.sepolia.mantle.xyz
SENTINEL_CHAIN_ID=5003
MANTLE_RPC=https://rpc.mantle.xyz
MANTLE_CHAIN_ID=5000
AUDIT_REGISTRY_ADDRESS=0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b
ALERT_BUS_ADDRESS=0x350dc422bb2979684573409f229679fed383b2e5
SENTINEL_AGENT_ID=120
DEEPSEEK_API_KEY=<key>
DUNE_API_KEY=<key>
MANTLE_OFT_QUERY_ID=7638642
MANTLE_SENTINEL_QUERY_ID=7664779
CORS_ORIGINS=https://oft-sentinel.netlify.app
TELEGRAM_BOT_TOKEN=<optional>
TELEGRAM_ALERT_CHAT_ID=<optional>
TELEGRAM_TEAM_ALERTS_JSON=<optional — {"DEMO":["<chat_id>"]}> 
```

4. Start command: `npm start` (configured in `railway.toml`)

### Frontend → Netlify

1. Connect `frontend/` directory (base dir: `frontend`)
2. Build command: `npm run build` / publish directory: `dist` (configured in `netlify.toml`)
3. Set env var: `VITE_API_URL=https://<your-railway-service>.up.railway.app`

**Smoke test after deploy:** run Kelp replay from https://oft-sentinel.netlify.app → verify `attest tx ↗` link opens a real tx on sepolia.mantlescan.xyz.

---

## Contract Tests

```bash
cd contracts && npm install && npm test
# 13/13 passing (AuditRegistry + AlertBus)
```

To deploy to Mantle Sepolia:
```bash
cd contracts
npm run deploy:testnet
# Then verify:
npx hardhat verify --network mantleSepolia <address>
```

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node 20 + Express + viem (ESM, TypeScript strict) |
| Frontend | React 18 + Vite + Tailwind (custom CSS, no component library) |
| Contracts | Hardhat 2 + hardhat-toolbox-viem (Solidity 0.8.27) |
| AI (reports + copilot) | DeepSeek — not in the critical security path; deterministic fallback if key unset |
| On-chain data | viem — direct reads of LZ endpoint (`0x1a44…728c`) on Mantle mainnet |
| Off-chain data | Dune Analytics — OFT leaderboard (query 7664779) |
| Alerts | Telegram Bot API + AlertBus on-chain MNT nudge |
| Chain (monitoring) | Mantle mainnet (5000, EID 30181) |
| Chain (attestations) | Mantle Sepolia (5003) |
| Agent identity | ERC-8004 canonical IdentityRegistry (`0x8004…BD9e`) |

---

## Post-Hackathon: LayerZero Security Intelligence Network (LSIN)

OFT Sentinel is LSIN v0: Mantle-focused, OFT-scoped. The architecture generalizes to every LayerZero V2 OApp across all ~170 EVM EIDs — the detection engine already reads all of them per OFT.

**Vision:** Become the canonical security monitoring layer for the entire LayerZero ecosystem — "CrowdStrike for LayerZero applications." LSIN continuously observes trust assumptions, detects security-relevant configuration changes, assesses impact, alerts stakeholders, and produces immutable attestations.

**Three layers:**
1. **Detection** — continuous config polling with multi-RPC quorum, baseline diffing, 14-check rule engine
2. **Intelligence** — deterministic findings + TIS remediations + pre-flight simulation + LLM narrative
3. **Attestation** — tamper-resistant on-chain record per event with PDR hash + ERC-8004 agent provenance
