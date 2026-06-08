# OFT Sentinel

**Autonomous security monitoring for LayerZero OFTs on Mantle.**

OFT Sentinel is an always-on agent that reads the live LayerZero DVN configuration for every major OFT on Mantle, detects security-relevant changes the moment they happen, writes immutable on-chain attestations, and alerts teams before funds move.

Built for the **Mantle Turing Test Hackathon** (Phase 2, June 2026). Tracks: AI DevTools + Alpha & Data.

---

## The Problem

On 18 April 2026, attackers drained a LayerZero bridge for $292M. The exploit vector: a single configuration change — one DVN dropped from two to one — that no monitoring system caught. A one-shot audit cannot catch a change it never sees again. An always-on agent can.

---

## Live Demo

> **Frontend:** https://oft-sentinel.netlify.app
> **Backend API:** deployed on Railway (set `VITE_API_URL` in Netlify to your Railway service URL)

**Demo flow (2 min):**
1. Visit the frontend → see the live fleet: 28 OFTs, 5 CRITICAL right now
2. Click "Run Kelp Replay" → Sentinel detects 1-of-1 DVN drift → CRITICAL verdict
3. Click the `attest tx ↗` link → see the real on-chain attestation at [sepolia.mantlescan.xyz](https://sepolia.mantlescan.xyz)
4. Open Security Copilot → ask "Why is cmETH risky?" → DeepSeek answers from live fleet data
5. Click ↓ on any OFT tile → download the AI-generated audit report

---

## Deployed Contracts (Mantle Sepolia, chain ID 5003)

| Contract | Address |
|---|---|
| AuditRegistry | [`0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b`](https://sepolia.mantlescan.xyz/address/0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b) |
| AlertBus | [`0x350dc422bb2979684573409f229679fed383b2e5`](https://sepolia.mantlescan.xyz/address/0x350dc422bb2979684573409f229679fed383b2e5) |

Deployer / Sentinel signer: `0xD618c61666d8848825E7e383c140eCd0Ad27e5aF`

---

## Architecture

```
Dune query 7638642 → 28 V2 OFTs on Mantle mainnet (5000)

Every 5 min:
  For each OFT:
    readSnapshot() via viem — peers(), getConfig(), getReceiveLibrary()
    assessSnapshot() → score (0–100) + riskLevel + findings
    appendScoreHistory() → score-history.jsonl

  runCheck(prev, next):
    detectDrift() → DVN count drop / conf fall / lib→default?
      YES → produceVerdict():
              assessSnapshot() → deterministic findings, no LLM
              AuditRegistry.attest() on Sepolia 5003 → attestTxHash
              AlertBus.alert() + Telegram → alertTxHash
              recordVerdict() → persistent JSON

Frontend polls /api/sentinel/status every 10s:
  fleet grid coloured by live assessment
  MSI = unweighted avg score across all watched OFTs

Security Copilot: POST /api/sentinel/ask
  fleet assessments injected as context → DeepSeek → grounded answer

Audit reports: GET /api/sentinel/report/:address
  assessSnapshot() + DVN metadata → DeepSeek narrative → markdown
```

**13-check scoring rubric** (score starts at 100, deductions applied, floor 0):

| Severity | Deduction | Example check |
|---|---|---|
| CRITICAL (−40) | Capped at 25 | DVN count ≤ 1 ("Kelp rsETH pattern"), receive lib is default |
| HIGH (−20) | | Send lib not pinned, EOA owner, cross-chain DVN mismatch |
| MEDIUM (−10) | | DVN count = 2, block confs < 15 |
| LOW (−5) | | Enforced options missing, self-DVN |

---

## Key Features

- **Live fleet monitoring** — 28 Mantle OFTs watched continuously (BOMB, BOX, cmETH, COQ, USDe, USDT0, rsETH, sUSDe, and more); watch list is dynamic from the Dune OFT leaderboard
- **Kelp replay** — reproduces the $292M exploit pattern on a live config; fires a real `attest()` tx on Mantle Sepolia
- **On-chain attestations** — every drift event written to `AuditRegistry` with verdict hash, score, risk level, and agent ID
- **DVN Concentration Panel** — identifies systemic risk (one DVN provider securing >60% of Mantle TVL)
- **Security Copilot** — DeepSeek-backed chat with full fleet context injection; 5 pre-staged demo questions
- **AI audit reports** — per-OFT markdown: deterministic findings tables + LLM narrative (corridor DVN config, trust assumptions, recommendations)
- **Intelligence Feed** — live security event stream (drift, attest, poll events)
- **Score history** — time-series MSI per OFT written to JSONL on every poll cycle
- **Telegram alerts** — live channel `@oft_sentinel_watcher`; team DMs per OFT configurable

---

## Local Setup

**Prerequisites:** Node 20+, a Mantle Sepolia funded key (`https://faucet.sepolia.mantle.xyz`)

```bash
git clone <repo>
cd oft-audit-product

# Copy and fill in env vars
cp .env.example .env
# Required: SENTINEL_PRIVATE_KEY, DUNE_API_KEY, DEEPSEEK_API_KEY
# Optional: TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID

# Backend (port 3001)
cd backend && npm install && npm run dev

# Frontend (port 5173)
cd frontend && npm install && npm run dev
```

For a clean demo: `rm backend/data/sentinel-state.json backend/data/score-history.jsonl`

**Verify:**
```bash
# Backend health
curl localhost:3001/api/health

# Fleet status (populated after ~60s first poll)
curl localhost:3001/api/sentinel/status | jq '.watched[0]'

# Kelp replay → real on-chain tx
curl -X POST localhost:3001/api/sentinel/replay-kelp \
  -d '{"ticker":"cmETH"}' -H 'content-type: application/json'
```

---

## Production Deployment

### Backend → Railway

1. Create Railway project, connect `backend/` directory
2. Add a **persistent volume** at `/data` (score history, verdict ledger)
3. Set env vars:

```
DATA_DIR=/data
NODE_ENV=production
SENTINEL_PRIVATE_KEY=<key>
SENTINEL_RPC=https://rpc.sepolia.mantle.xyz
SENTINEL_CHAIN_ID=5003
MANTLE_RPC=https://rpc.mantle.xyz
MANTLE_CHAIN_ID=5000
AUDIT_REGISTRY_ADDRESS=0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b
ALERT_BUS_ADDRESS=0x350dc422bb2979684573409f229679fed383b2e5
SENTINEL_AGENT_ID=1
DEEPSEEK_API_KEY=<key>
DUNE_API_KEY=<key>
MANTLE_OFT_QUERY_ID=7638642
CORS_ORIGINS=https://oft-sentinel.netlify.app
TELEGRAM_BOT_TOKEN=<optional>
TELEGRAM_ALERT_CHAT_ID=<optional>
```

4. Start command: `npm start` (already in `railway.toml`)

### Frontend → Netlify

1. Connect `frontend/` directory
2. Build command: `npm run build` / publish: `dist` (already in `netlify.toml`)
3. Set env var: `VITE_API_URL=https://<your-railway>.up.railway.app`

**Smoke test:** Kelp replay from the deployed URL → verify `attest` tx appears on [sepolia.mantlescan.xyz](https://sepolia.mantlescan.xyz)

---

## Contract Tests

```bash
cd contracts && npm install && npm test
# 13/13 passing
```

---

## Stack

- **Backend:** Node 20 + Express + viem (ESM, TypeScript)
- **Frontend:** React 18 + Vite + Tailwind (no component library, custom CSS)
- **Contracts:** Hardhat 2 + hardhat-toolbox-viem (Solidity 0.8)
- **AI:** DeepSeek (audit reports + Security Copilot)
- **Data:** Dune Analytics (OFT leaderboard, query 7638642)
- **Alerts:** Telegram Bot API
- **Chain:** Mantle mainnet (5000, OFT monitoring) + Mantle Sepolia (5003, attestations)

---

## Post-Hackathon: LayerZero Security Intelligence Network

OFT Sentinel is LSIN v0: Mantle-focused, OFT-scoped. The architecture generalizes to every LayerZero V2 OApp across all ~170 EVM EIDs. The detection engine already reads all of them per OFT — expanding coverage is additive. Target: canonical security monitoring layer for the entire LayerZero ecosystem ("CrowdStrike for LayerZero applications").
