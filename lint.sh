#!/usr/bin/env bash
# Lint, format, typecheck, and verify generated types. Safe to run from any working directory.
# Usage: ./lint.sh [--fix]   Pass --fix to apply auto-fixes instead of checking.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

FIX=true
for arg in "$@"; do
  [[ "$arg" == "--fix" ]] && FIX=true
done

echo "▶ Installing dependencies..."
pnpm install --frozen-lockfile

echo ""
if $FIX; then
  echo "▶ Formatting and auto-fixing (biome check --write)..."
  pnpm biome check --write .
else
  echo "▶ Lint + format check (biome check)..."
  pnpm biome check .
fi

echo ""
echo "▶ Checking generated manifest types..."
pnpm gen:types:check

echo ""
echo "▶ Typechecking..."
pnpm typecheck

echo ""
echo "✔ All checks passed."
