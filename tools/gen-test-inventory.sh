#!/usr/bin/env bash
# Regenerate docs/test-inventory.md from describe/it strings. Do not hand-edit the output.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
OUT="$ROOT/docs/test-inventory.md"
{
  echo "# Test inventory (GENERATED $(date +%F) by tools/gen-test-inventory.sh — do not hand-edit)"
  echo
  for dir in backend/src/__tests__ contracts/test; do
    echo "## $dir"
    for f in "$ROOT"/$dir/*.test.ts; do
      [ -f "$f" ] || continue
      echo "### $(basename "$f")"
      grep -hoE '(describe|it|test)\((["'"'"'`])[^"'"'"'`]+' "$f" \
        | sed -E 's/^describe\(./- **suite** /; s/^(it|test)\(./  - /' || true
    done
    echo
  done
} > "$OUT"
echo "wrote $OUT ($(grep -c '^  - ' "$OUT") cases)"
