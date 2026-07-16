#!/usr/bin/env bash
# Pull git and DVC resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/dev.sh" pull --editor "$@"
