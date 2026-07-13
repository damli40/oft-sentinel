#!/usr/bin/env bash
# Check 1: grep staged content for confidential identifiers.
# Patterns come from two GITIGNORED sources so the public hook never names them:
#   - tools/githooks/confidentiality-patterns.txt (one ERE per line, # = comment)
#   - asset tickers/addresses walked out of backend/data/corridor-invariants.json
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
PATTERNS_FILE="$ROOT/tools/githooks/confidentiality-patterns.txt"
if [ ! -f "$PATTERNS_FILE" ]; then
  echo "confidentiality: $PATTERNS_FILE missing — failing closed."
  echo "Create it (gitignored). See AGENTS.md > Pre-commit hooks."
  exit 1
fi
PATTERNS="$(grep -vE '^\s*(#|$)' "$PATTERNS_FILE" || true)"
WALKER="$ROOT/tools/githooks/checks/extract-asset-patterns.mjs"
INV="$ROOT/backend/data/corridor-invariants.json"
if [ -f "$INV" ] && command -v node >/dev/null; then
  DYN="$(node "$WALKER" "$INV" 2>/dev/null || true)"
  PATTERNS="$(printf '%s\n%s' "$PATTERNS" "$DYN")"
fi
# Drop empty lines: an empty ERE matches every line under GNU grep (portability
# beyond BSD grep), and printf above emits a blank line when static patterns are absent.
PATTERNS="$(printf '%s\n' "$PATTERNS" | grep -v '^$' || true)"
[ -n "$PATTERNS" ] || exit 0
STATUS=0
while IFS= read -r file; do
  case "$file" in tools/githooks/confidentiality-patterns.txt) continue;; esac
  HITS="$(git show ":$file" | grep -nIE -f <(printf '%s\n' "$PATTERNS") || true)"
  if [ -n "$HITS" ]; then
    echo "confidentiality: hit in $file:"
    echo "$HITS" | head -5
    STATUS=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR)
exit $STATUS
