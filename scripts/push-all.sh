#!/usr/bin/env bash
# Push DVC resources and git commits.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/dev.sh" push "$@"
