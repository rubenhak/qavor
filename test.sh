#!/usr/bin/env bash
# Install, build, and run the CLI. Safe to run from any working directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

exec npm run test "$@"
