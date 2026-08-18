#!/bin/sh
# 跨平台 python 入口:优先项目 venv,其次能真实执行的 python3/python。
# 背景:部分 Windows 机器上 python3 是 MS Store 占位 stub,静默失败(exit 49 无输出),
# 直写 python3 的 hook/入口会全部静默空转。本脚本失败必出声,绝不静默。
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
for CAND in "$ROOT/.tools/venv/Scripts/python.exe" "$ROOT/.tools/venv/bin/python"; do
  if [ -x "$CAND" ]; then
    exec "$CAND" "$@"
  fi
done
for CAND in python3 python; do
  if command -v "$CAND" >/dev/null 2>&1 && "$CAND" -c "" >/dev/null 2>&1; then
    exec "$CAND" "$@"
  fi
done
echo "[scripts/py.sh] 找不到可用的 python:.tools/venv 缺失,且 python3/python 均不可真实执行" >&2
exit 1
