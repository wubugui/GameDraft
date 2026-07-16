#!/usr/bin/env bash
# macOS/Linux task entry: ./dev.sh <task> [args]
# Run ./dev.sh --help for the task list.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PY="$ROOT/.tools/venv/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "Project venv missing. Run ./bootstrap.sh first." >&2
  exit 1
fi

cd "$ROOT"
exec "$VENV_PY" -m tools.dev "$@"
