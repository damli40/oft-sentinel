#!/usr/bin/env bash
# Check 3: tsc --noEmit when backend TS is staged.
set -euo pipefail
git diff --cached --name-only --diff-filter=ACMR | grep -qE '^backend/.*\.ts$' || exit 0
ROOT="$(git rev-parse --show-toplevel)"
echo "pre-commit: tsc --noEmit (backend)"
(cd "$ROOT/backend" && npx tsc --noEmit)
