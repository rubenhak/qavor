#!/usr/bin/env bash
# Run the test suite. Safe to run from any working directory.
#
# Usage:
#   ./test.sh                              # run all tests
#   ./test.sh test/git.test.ts             # run a single file
#   ./test.sh test/git.test.ts test/env.test.ts   # run several files
#   ./test.sh --test-name-pattern='clone'  # filter by test name across the default file set
#   ./test.sh --test-name-pattern='clone' test/git.test.ts  # filter within a file
#
# Notes:
#   - Pass option flags in --flag=value form so they are not mistaken for file paths.
#   - When no file path is given, the default file set (all test/**/*.test.ts) is used.
#     The list is expanded here into explicit paths rather than passed to node as a
#     glob — node's own glob handling misbehaves when combined with
#     --test-name-pattern (node v26).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Default set of test files, used when the caller passes no file paths. Built with
# find (rather than a `**` glob) so this works on bash 3.2 (macOS) too.
default_files=()
while IFS= read -r f; do
  default_files+=("$f")
done < <(find test -type f -name '*.test.ts' | sort)

# Detect whether the caller supplied any positional (non-flag) file arguments.
has_files=false
for arg in "$@"; do
  case "$arg" in
    -*) ;;            # an option flag, not a file
    *) has_files=true ;;
  esac
done

if [ "$has_files" = true ]; then
  exec node --import tsx --test --test-reporter=spec "$@"
else
  exec node --import tsx --test --test-reporter=spec "$@" "${default_files[@]}"
fi
