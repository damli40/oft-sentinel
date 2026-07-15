#!/usr/bin/env bash
# Check 2: local-only worksheet files must never be staged.
set -euo pipefail
BLOCKED='^(handoff\.md|log\.md|docs/superpowers/|backend/data/)'
if git diff --cached --name-only | grep -qE "$BLOCKED"; then
  echo "guardrails: a local-only file is staged:"
  git diff --cached --name-only | grep -E "$BLOCKED"
  exit 1
fi
