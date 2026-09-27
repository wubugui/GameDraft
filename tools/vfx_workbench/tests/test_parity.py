# -*- coding: utf-8 -*-
"""工作台画面 == 游戏画面（真 GPU 那一半）：`tests/parity/run.mjs` 在 Chrome（真显卡 WebGPU）里让粒子工作台真页面的原画视图
与「照游戏组装层现拼」的参考页各跑同一个模拟、各画同一组输入（效果 + 种子 / 锚点 + 场景空间 + 风 + 步长 + 相机 + 画布 + 背景 + 深度），
先比模拟摘要、再逐字节比整张画布。用例：纸钱、雷符的云与雨、光柱里的尘埃、落雷（含高分屏）。

无 GPU 的那一半（逐条 GPU 命令与字节）是 vitest：`tools/vfx_workbench/gpu/vfxView.test.ts`。
没有 node / playwright-core / Chrome ⇒ skip。缺工程真数据（场景深度 / 效果）⇒ skip。服务开在自检沙箱里，对照不写任何东西。
"""
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

_RUN = _ROOT / "tools" / "vfx_workbench" / "tests" / "parity" / "run.mjs"
_RT = _ROOT / "public" / "resources" / "runtime" / "scenes"
_DATA_OK = all((_RT / s / "raw_depth_rg.png").is_file() for s in ("跑马梁", "bridge_underpass", "崖墓前段")) and \
    (_ROOT / "public" / "resources" / "runtime" / "animation" / "fx_paper_money" / "anim.json").is_file()


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
@pytest.mark.skipif(not _DATA_OK, reason="缺工程真数据（跑马梁 / bridge_underpass / 崖墓前段 的深度、纸钱动画包）")
def test_workbench_pixels_equal_game_pixels_on_real_gpu(tmp_path: Path) -> None:
    env = dict(os.environ, PLAYWRIGHT_CORE=browser.playwright_core() or "", PYTHONUTF8="1")
    r = subprocess.run([node_exe() or "node", str(_RUN), "--python", sys.executable, "--out", str(tmp_path)], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, env=env)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-3000:])
    if r.returncode == 3:
        pytest.skip("起不来 Chrome / 没有 playwright-core")
    assert r.returncode == 0, "工作台画面与游戏画面不是逐字节相同（差异图在输出目录）"
    assert "6/6 例逐字节相同" in r.stdout
    assert "DIFF" not in r.stdout and "不同步" not in r.stdout
