# OFT Sentinel — Contracts

On-chain benchmark ledger for the OFT Sentinel agent (Mantle Turing Test Hackathon 2026).

## AuditRegistry.sol

Immutable, timestamped store of security verdicts produced by the Sentinel AI agent.
Each `attest()` call is the on-chain footprint of an off-chain AI security audit — it
commits a trust score, a risk level, and the `keccak256` hash of the full verdict report
to Mantle. This is the hackathon's **"on-chain benchmarking of AI"** feature and the
**AI-powered function callable on-chain** required by the 20 Project Deployment Award.

Key surface:

| Function | Who | Purpose |
|---|---|---|
| `attest(oft, chainId, verdictHash, score, risk, agentId)` | authorised agent | record a verdict; emits `Attested` |
| `latestOf(oft, chainId)` | anyone | latest verdict for a target |
| `historyOf(oft, chainId)` | anyone | full attestation history (config-drift timeline) |
| `get(id)` / `total()` / `countOf(...)` | anyone | reads |
| `setAgent(addr, bool)` / `transferOwnership(addr)` | owner | admin |

`agentId` is the **ERC-8004 identity NFT** token id of the attesting Sentinel, tying every
verdict to an on-chain agent reputation record.

## Develop

```bash
npm install
npx hardhat compile        # solc 0.8.24, evmVersion paris (L2-safe)
npx hardhat test           # 7 passing
```

## Deploy + verify (Mantle)

```bash
cp .env.example .env        # set DEPLOYER_PRIVATE_KEY (+ MANTLESCAN_API_KEY)
# faucet: https://faucet.sepolia.mantle.xyz

npm run deploy:testnet      # Mantle Sepolia (chainId 5003)
npx hardhat verify --network mantleSepolia <address>

npm run deploy:mainnet      # Mantle mainnet (chainId 5000)
npx hardhat verify --network mantle <address>
```

Put the deployed address in the backend `.env` as `AUDIT_REGISTRY_ADDRESS` and in the
DoraHacks submission (required deployed contract address).
