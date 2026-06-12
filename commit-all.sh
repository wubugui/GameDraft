#!/usr/bin/env bash
# macOS/Linux one-shot equivalent of commit-all.cmd.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/dev.sh" commit "$@"
