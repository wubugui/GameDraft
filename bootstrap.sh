#!/usr/bin/env bash
# GameDraft bootstrap for macOS/Linux. Creates a project venv (.tools/venv)
# from a system Python 3.11+, installs DVC, then delegates to the Python task
# runner.
#
# Usage:
#   ./bootstrap.sh                 # menu (game / editor / clean)
#   ./bootstrap.sh game|editor|clean
#   ./bootstrap.sh --skip-resources   # only build the venv, no OSS pulls
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/.tools/venv"
VENV_PY="$VENV/bin/python"

SKIP_RESOURCES=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--skip-resources" ]; then
    SKIP_RESOURCES=1
  else
    ARGS+=("$arg")
  fi
done

find_python() {
  for cand in python3.12 python3.11 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
      if "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 11) else 1)'; then
        echo "$cand"
        return 0
      fi
    fi
  done
  return 1
}

if [ ! -x "$VENV_PY" ]; then
  PY="$(find_python)" || {
    echo "ERROR: need Python 3.11+ on PATH (tried python3.12 / python3.11 / python3)." >&2
    echo "  macOS:  brew install python@3.11" >&2
    echo "  Linux:  use your package manager or pyenv" >&2
    exit 1
  }
  echo "Creating venv at .tools/venv using $PY ..."
  "$PY" -m venv "$VENV"
  "$VENV_PY" -m pip install -U pip >/dev/null
  echo "Installing DVC (dvc, dvc-oss) ..."
  "$VENV_PY" -m pip install -c "$ROOT/config/python-deps-constraints.txt" dvc dvc-oss
fi

if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: node not found on PATH. Install Node 20+ before running the dev server." >&2
  echo "  macOS: brew install node    Linux: use nvm or your package manager" >&2
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "WARNING: node $(node -v) detected; Node 20+ recommended." >&2
  fi
fi

if [ "$SKIP_RESOURCES" = "1" ]; then
  echo "Venv ready (--skip-resources): skipped OSS resource pulls."
  "$VENV_PY" -m dvc --version
  exit 0
fi

exec "$VENV_PY" -m tools.dev bootstrap "${ARGS[@]}"
