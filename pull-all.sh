#!/usr/bin/env bash
# macOS/Linux one-shot equivalent of pull-all.cmd.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/dev.sh" pull --editor --vendor --git-proxy http://127.0.0.1:7078 "$@"
