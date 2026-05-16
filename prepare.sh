#!/usr/bin/env bash
# Install dependencies and build. Safe to run from any working directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

pnpm install
pnpm run build
