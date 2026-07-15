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
printf 'handoff.md\nlog.md\nbackend/\ntools/githooks/confidentiality-patterns.txt\n' > .gitignore
printf '# test patterns\nFAKEBADTOKEN\n' > tools/githooks/confidentiality-patterns.txt
# Fixture drives the dynamic (walker) path. Gitignored backend/, fake values only.
mkdir -p backend/data
printf '%s\n' '{"cases":[{"name":"FAKETICK eth→bsc — prose that DELIVERS ANYWAY","oft":"0xffffffffffffffffffffffffffffffffffffffff"}]}' > backend/data/corridor-invariants.json

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

# Dynamic-path (walker) coverage — fixture above supplies FAKETICK + 0xfff… address.
echo "leak FAKETICK here" > dyn1.txt && git add dyn1.txt
check "dynamic ticker (name leading token) blocks commit" 1 git commit -q -m dyn1
git reset -q dyn1.txt && rm dyn1.txt

echo "leak 0xffffffffffffffffffffffffffffffffffffffff here" > dyn2.txt && git add dyn2.txt
check "dynamic address blocks commit" 1 git commit -q -m dyn2
git reset -q dyn2.txt && rm dyn2.txt

# Regression guard for Finding 1: prose CAPS words in a name field must NOT block.
echo "this DELIVERS ANYWAY as designed" > dyn3.txt && git add dyn3.txt
check "prose caps (DELIVERS ANYWAY) does NOT block" 0 git commit -q -m dyn3
git reset -q dyn3.txt 2>/dev/null || true; rm -f dyn3.txt

rm tools/githooks/confidentiality-patterns.txt
echo ok > ok.txt && git add ok.txt
check "missing patterns file fails closed" 1 git commit -q -m ok

exit $FAIL
