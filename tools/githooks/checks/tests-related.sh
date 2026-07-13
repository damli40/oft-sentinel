#!/usr/bin/env bash
# Check 4: run vitest on tests related to staged backend sources (fast, targeted).
# Full suite is an end-of-shift concern (AGENTS.md checklist), not per-commit.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
STAGED=()
while IFS= read -r f; do STAGED+=("$f"); done < <(git diff --cached --name-only --diff-filter=ACMR | grep -E '^backend/src/.*\.ts$' | sed 's|^backend/||' || true)
# NOTE: no mapfile — macOS ships bash 3.2
[ "${#STAGED[@]}" -gt 0 ] || exit 0
TESTS=(); SRCS=()
for f in "${STAGED[@]}"; do
  case "$f" in *__tests__*|*.test.ts) TESTS+=("$f");; *) SRCS+=("$f");; esac
done
cd "$ROOT/backend"
if [ "${#TESTS[@]}" -gt 0 ]; then echo "pre-commit: vitest run (staged tests)"; npx vitest run "${TESTS[@]}"; fi
if [ "${#SRCS[@]}" -gt 0 ]; then echo "pre-commit: vitest related (staged sources)"; npx vitest related --run "${SRCS[@]}"; fi
