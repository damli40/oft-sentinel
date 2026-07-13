# Scripts

Safety classes: `read-only` (safe always) · `writes-disk` (local state) · `writes-chain+alerts` (real gas, public alerts — never run casually).

| Script | Class | What it does |
| --- | --- | --- |
| `scan-readonly.ts` | read-only | Mirrors the poll read path, writes nothing on-chain. `SCAN_OUT=<file.ndjson>` required; `SCAN_CONCURRENCY` default 3. THE way to inspect findings. |
| `verify-dvn-invariants.ts` | read-only | Re-derives the load-bearing DVN-feed facts; non-zero exit when reality moves. Run before/after touching the DVN layer. |
| `verify-corridor-invariants.ts` | read-only | Same pattern for corridor/deliverability facts; reads gitignored fixture. |
| `verify-multichain-watchlist.ts` | read-only | Checks the multi-chain watchlist resolution. |
| `build-chain-registry.ts` | writes-disk | Regenerates `backend/chain-registry.json` from the RPC sweep input. |
| `custody-demo.ts` | read-only | Before/after demo of the custody-declaration rule (stdout only). |
| `test-telegram.ts` | writes-chain+alerts | Sends a REAL Telegram message. |

The poller itself (`src/index.ts` / `pollOnce`) is `writes-chain+alerts`: attests on-chain and fires public alerts with an in-memory dedupe that resets per process. See AGENTS.md safety block.

Convention: a task done manually twice gets a script the third time; add it here with a safety class in the same commit.
