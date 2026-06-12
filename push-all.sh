#!/usr/bin/env bash
# macOS/Linux one-shot equivalent of push-all.cmd.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/dev.sh" push --git-proxy http://127.0.0.1:7078 "$@"
