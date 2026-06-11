#!/usr/bin/env bash
# Cross-platform task entry for macOS/Linux: ./dev.sh <task> [args]
# Mirrors the Windows .cmd launchers. Run ./dev.sh --help for the task list.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PY="$ROOT/.tools/venv/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "Project venv missing. Run ./bootstrap.sh first." >&2
  exit 1
fi

exec "$VENV_PY" -m tools.dev "$@"
