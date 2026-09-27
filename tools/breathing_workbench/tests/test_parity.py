# -*- coding: utf-8 -*-
"""工作台画面 == 游戏画面(真 GPU 那一半):`tests/parity/run.mjs` 在 Chrome(真显卡 WebGPU)里让工作台真页面与
「照游戏组装层现拼」的参考页各画同一组输入(呼吸图 + 表演帧 + 屏的尺寸 / 分辨率),逐字节比整张图——
预览对游戏画布,出片(离屏渲染纹理异步回读)对引擎自己的离屏读法,并报与游戏画布的差(引擎画布翻转光栅化,≤1 且 ≤0.1% 像素)。

无 GPU 的那一半(逐条 GPU 命令与字节)是 vitest:`tools/breathing_workbench/gpu/breathingView.test.ts`。
没有 node / playwright-core / Chrome ⇒ skip。整个对照只在临时样例工程上跑(参考页也只经代理读它)。
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

_RUN = _ROOT / "tools" / "breathing_workbench" / "tests" / "parity" / "run.mjs"


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_workbench_pixels_equal_game_pixels_on_real_gpu(tmp_path: Path) -> None:
    env = dict(os.environ, PLAYWRIGHT_CORE=browser.playwright_core() or "", PYTHONUTF8="1")
    r = subprocess.run([node_exe() or "node", str(_RUN), "--python", sys.executable, "--out", str(tmp_path)], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, env=env)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-3000:])
    if r.returncode == 3:
        pytest.skip("起不来 Chrome / 没有 playwright-core")
    assert r.returncode == 0, "工作台画面与游戏画面不是逐字节相同(差异图在输出目录)"
    assert "7/7 例逐字节相同" in r.stdout
    assert "DIFF" not in r.stdout and "超出容差" not in r.stdout
