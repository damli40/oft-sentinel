# @oft-sentinel/mcp

**The MCP server that won't let an agent ship a Kelp.**

Six read+validate tools over [OFT Sentinel](https://oft-sentinel.netlify.app) — the LayerZero OFT config-drift monitor with on-chain attestations. An agent can check any watched OFT's DVN security config, validate a proposed config against the same deterministic rule engine that produces Sentinel's attestations, and independently verify those attestations against the chain. It cannot deploy, sign, bridge, or write anything: **no write tools exist by design.** A 1-of-1 DVN route is how Kelp rsETH lost $292M — the pre-flight check exists so no agent ships that shape again.

## Tools

| Tool | When an agent uses it |
|------|----------------------|
| `list_fleet` | First call: find an asset's address/chain; filter by chain or risk band |
| `get_oft_config` | Read one OFT's per-corridor DVN sets, thresholds, effective counts |
| `get_verdict` | Current score/risk + reasons + remediation, and the last attested verdict |
| `get_drift_history` | When did the config drift, and what was attested about it |
| `verify_attestation` | Trustlessly recompute the PDR hash locally and compare against AuditRegistry on-chain — does not trust the backend |
| `validate_config` | Pre-flight a proposed config against the rule engine BEFORE shipping it; refuses nothing, but tells you plainly: DO NOT SHIP on CRITICAL |

All six carry `readOnlyHint: true`. Outputs are distilled for token economy — nothing proxies raw backend payloads.

## Install / run

```bash
cd mcp && npm ci && npm run build   # → dist/index.js (stdio server)
```

**Claude Code:**

```bash
claude mcp add oft-sentinel -- node /abs/path/to/oft-sentinel/mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

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

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SENTINEL_API_URL` | the production Sentinel API | Backend to read from |
| `SENTINEL_SEPOLIA_RPC` | `https://rpc.sepolia.mantle.xyz` | Mantle Sepolia RPC for the trustless attestation read. Env-only on purpose — never a tool input an agent could redirect |

## Trust model

`verify_attestation` is the reason to believe the rest: it recomputes `keccak256(JSON.stringify(pdr))` locally from the policy decision record and compares it against both the backend's stored hash and the hash in the AuditRegistry contract (Mantle Sepolia, ERC-8004 agent 120). A `MISMATCH` is returned as a normal result — it's a finding about the backend, which is exactly the point.

## v1 boundary

No writes, no keys, no deploys, no bridging. v2 (guarded **testnet** deploys that refuse 1-of-1 DVN configs) and v3 (mainnet) are explicitly out of scope for now.
