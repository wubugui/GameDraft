# -*- coding: utf-8 -*-
"""实验室画面 == 游戏画面(真 GPU 那一半):`tests/parity/run.mjs` 在 Chrome(真显卡 WebGPU)里让实验室真页面与
「照游戏组装层现拼」的参考页(vite 按游戏模块图编译 `src/`)各画同一组输入(虚拟烘焙目录 + 脚点 / 角色高 + 着色参数 +
相机 + 画布尺寸 / 分辨率 + 背景),逐字节比整张画布。六例:L1 + 遮挡、八面体放大、SH + 法线视图、RT + NEE + miss 不计、
合成参数改了(换一份虚拟载荷)、预览亮度 ×2 + 1.5 倍分辨率。

无 GPU 的那一半(逐条 GPU 命令与字节)是 vitest:`tools/character_lighting_lab/gpu/charLabView.test.ts`。
用本机工作台已烘的场景(真工程数据);没有 ⇒ skip。没有 node / playwright-core / Chrome ⇒ skip。
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

_RUN = _ROOT / "tools" / "character_lighting_lab" / "tests" / "parity" / "run.mjs"


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_lab_pixels_equal_game_pixels_on_real_gpu(tmp_path: Path) -> None:
    env = dict(os.environ, PLAYWRIGHT_CORE=browser.playwright_core() or "", PYTHONUTF8="1")
    r = subprocess.run([node_exe() or "node", str(_RUN), "--python", sys.executable, "--out", str(tmp_path)], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1200, env=env)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-3000:])
    if r.returncode == 3:
        pytest.skip("起不来 Chrome / 没有 playwright-core")
    if r.returncode == 4:
        pytest.skip("本机工作台没有已烘场景")
    assert r.returncode == 0, "实验室画面与游戏画面不是逐字节相同(差异图在输出目录)"
    assert "6/6 例逐字节相同" in r.stdout
    assert "DIFF" not in r.stdout
