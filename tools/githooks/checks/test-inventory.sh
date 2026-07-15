#!/usr/bin/env bash
# Check 5: regen the (local-only) test inventory when test files are staged. Never blocks.
set -euo pipefail
# Capture (not grep -q): under pipefail, grep -q closes the pipe on first match and
# git dies with SIGPIPE 141 — the pipeline exits non-zero and `|| exit 0` would SKIP
# regen exactly when tests ARE staged. See tools/githooks/checks/typecheck.sh.
STAGED="$(git diff --cached --name-only --diff-filter=ACMRD \
  | grep -E '(__tests__/.*\.test\.ts|contracts/test/.*\.test\.ts)$' || true)"
[ -n "$STAGED" ] || exit 0
"$(git rev-parse --show-toplevel)/tools/gen-test-inventory.sh" || echo "test-inventory: regen failed (non-blocking)"
exit 0
