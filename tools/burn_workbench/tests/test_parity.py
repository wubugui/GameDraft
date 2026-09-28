# -*- coding: utf-8 -*-
"""真 GPU 对照：B 工作台 vs 固定 master BurnGL + GLSL，原有五组输入，按迁移既定每通道差 ≤1 判据；exactEqual 同时报出。
完整独立旧 A 工具 / B 工具的 A/B 另行验收，不能用 B 游戏滤镜当旧工具参照。"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.workbench_rhi import browser  # noqa: E402
from tools.workbench_rhi.build import node_exe  # noqa: E402

_RUN = _ROOT / "tools" / "burn_workbench" / "tests" / "parity" / "run.mjs"


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_workbench_pixels_equal_legacy_tool_on_real_gpu(tmp_path: Path) -> None:
    env = dict(os.environ, PLAYWRIGHT_CORE=browser.playwright_core() or "", PYTHONUTF8="1")
    r = subprocess.run([node_exe() or "node", str(_RUN), "--python", sys.executable, "--out", str(tmp_path)], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, env=env)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-3000:])
    if r.returncode == 3:
        pytest.skip("起不来 Chrome / 没有 playwright-core")
    assert r.returncode == 0, "工作台画面与旧 master 工具差异超过每通道 1 或捕获无效（差异图在输出目录）"
    assert "5/5 例每通道差 ≤1" in r.stdout
    assert "FAIL" not in r.stdout
