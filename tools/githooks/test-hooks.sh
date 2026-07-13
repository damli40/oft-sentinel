#!/usr/bin/env bash
# Scratch-repo test for the pre-commit hooks. Run from anywhere; no network.
set -euo pipefail
HOOKS_SRC="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
FAIL=0

cd "$SCRATCH"
git init -q .
git config user.email t@t && git config user.name t
mkdir -p tools/githooks
cp -R "$HOOKS_SRC/checks" tools/githooks/ 2>/dev/null || true
cp "$HOOKS_SRC/pre-commit" tools/githooks/ 2>/dev/null || true
chmod +x tools/githooks/pre-commit tools/githooks/checks/*.sh 2>/dev/null || true
git config core.hooksPath tools/githooks
printf 'handoff.md\nlog.md\ntools/githooks/confidentiality-patterns.txt\n' > .gitignore
printf '# test patterns\nFAKEBADTOKEN\n' > tools/githooks/confidentiality-patterns.txt

check() { # $1 desc, $2 expected exit (0|1), rest: command
  local desc="$1" want="$2"; shift 2
  if "$@" >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then echo "PASS: $desc"; else echo "FAIL: $desc (want exit $want, got $got)"; FAIL=1; fi
}

echo clean > clean.txt && git add clean.txt .gitignore
check "clean commit passes" 0 git commit -q -m clean

echo "contains FAKEBADTOKEN here" > leak.txt && git add leak.txt
check "pattern hit blocks commit" 1 git commit -q -m leak
git reset -q leak.txt && rm leak.txt

echo notes > handoff.md && git add -f handoff.md
check "staged guardrail file blocks commit" 1 git commit -q -m handoff
git reset -q handoff.md && rm handoff.md

rm tools/githooks/confidentiality-patterns.txt
echo ok > ok.txt && git add ok.txt
check "missing patterns file fails closed" 1 git commit -q -m ok

exit $FAIL
