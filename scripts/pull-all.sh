#!/usr/bin/env bash
# macOS/Linux equivalent of scripts/pull-all.ps1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/dev.sh" pull "$@"
