#!/bin/zsh
set -eu

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
exec "${PROJECT_ROOT}/.tools/venv/bin/python" \
  -m tools.task_orchestration_editor "${PROJECT_ROOT}"
