#!/usr/bin/env bash
# Add DVC/git changes and create a commit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 \"commit message\" | $0 -m \"commit message\"" >&2
  exit 2
fi

if [ "$1" = "-m" ] || [ "$1" = "--message" ]; then
  exec "$ROOT/dev.sh" commit "$@"
fi

exec "$ROOT/dev.sh" commit -m "$1"
