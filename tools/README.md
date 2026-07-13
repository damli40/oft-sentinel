<!--
  tools/ — developer tooling for this repo (all local, no network at commit time).
  Contents: a deterministic pre-commit hook suite under githooks/, a generator for
  the local test inventory, and a static declarations editor served over http.
  The hooks enforce confidentiality and worksheet guardrails BEFORE a commit lands;
  they run no LLM and perform no autofix. Bypassing them (--no-verify) is never
  acceptable for a confidentiality or guardrail failure. This file is committable —
  keep it free of tickers, addresses, names, and channel identifiers.
-->

# Tools

Deterministic developer tooling. The pre-commit suite runs local-only checks (no network, no LLM, no autofix) and fails closed.

## Activation

```bash
git config core.hooksPath tools/githooks
```

Point git at the tracked hooks once per clone. After this, every commit runs `tools/githooks/pre-commit`.

## Pre-commit suite (`githooks/`)

`pre-commit` is the dispatcher: it runs every executable `checks/*.sh` in order and exits non-zero on the first failure (`pre-commit: BLOCKED by <check>`).

| Check | Blocks? | What it does |
| --- | --- | --- |
| `checks/confidentiality.sh` | yes | Greps staged content for confidential identifiers. Patterns come from two gitignored sources so the public hook never names them. Missing patterns file → fails closed. |
| `checks/guardrails.sh` | yes | Rejects any staged local-only worksheet file (handoff/log/local data paths that must never be committed). |
| `checks/typecheck.sh` | yes | Runs `tsc --noEmit` on the backend when backend TS is staged; no-op otherwise. |
| `checks/tests-related.sh` | yes | Runs the test runner on tests related to staged backend sources (fast, targeted). Full suite is an end-of-shift concern. |
| `checks/test-inventory.sh` | no | Regenerates the local test inventory when test files are staged; never blocks. |

Helpers in `checks/` (not themselves checks): `extract-asset-patterns.mjs` derives grep patterns from the gitignored fixture for the confidentiality check, and `ticker-stoplist.txt` is the committed engine-vocabulary stoplist that keeps ordinary terms from becoming commit blockers.

`test-hooks.sh` is the harness: it builds a throwaway scratch repo with fake values, wires the hooks in, and asserts the pass/block behavior of every check (including the fail-closed path). Run it from anywhere; no network required.

## Other tools

| Tool | What it does |
| --- | --- |
| `gen-test-inventory.sh` | Regenerates the generated test inventory doc from the describe/it strings in the test suites. Do not hand-edit its output. |
| `declarations-editor.html` | Static editor for declaration data. Serve it locally: `python3 -m http.server 4599 -d tools`, then open the page from that server. |

## Confidentiality patterns file (required)

`githooks/confidentiality-patterns.txt` is **gitignored** and **must exist** locally. The confidentiality check reads it (one ERE pattern per line) plus patterns walked out of a gitignored fixture. If the file is absent, the check fails closed and blocks the commit. Create it after cloning; see AGENTS.md for the pattern format.
