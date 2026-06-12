#!/usr/bin/env bash
# Open the unified GameDraft control console.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/dev.sh" console "$@"
