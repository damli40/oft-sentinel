#!/usr/bin/env bash
# Check 3: tsc --noEmit when backend TS is staged.
set -euo pipefail
# capture (not grep -q): -q closes the pipe early, git dies with SIGPIPE, and
# under pipefail the 141 takes the `|| exit 0` branch — silently SKIPPING tsc
# on large staged sets. grep without -q consumes all input; no SIGPIPE.
STAGED_TS="$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^backend/.*\.ts$' || true)"
[ -n "$STAGED_TS" ] || exit 0
ROOT="$(git rev-parse --show-toplevel)"
echo "pre-commit: tsc --noEmit (backend)"
(cd "$ROOT/backend" && npx tsc --noEmit)
