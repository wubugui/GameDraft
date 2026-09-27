# -*- coding: utf-8 -*-
"""交互层端到端回归门:同一份 `viewer/tests/selftest.js` 在两个宿主里跑真页面——

* **桌面壳**(offscreen QtWebEngine,即工作台的真宿主):交互层全部断言;这个宿主拿不到 WebGPU 时(offscreen 的
  QtWebEngine 6.11 目前如此,统一的 WebGPU 参数由 `tools/qt_webgpu.py` 另接),画面那几条(S1 渲染器、S10 / S11 读像素、S17 出片)
  记 SKIP 并写明原因;
* **真 GPU 的 Chrome**(`tools/workbench_rhi/chrome_page.mjs`):同一份脚本,`--no-skip`——画面每一条都必须真跑、真过;
  另有一条冒烟:拿到 WebGPU、画面非空、控制台无 error。没有 node / playwright-core / Chrome 就 skip。

覆盖:自检工程自证、页面里没有 GLSL / WebGL(画面 = 游戏的 WebGPU 渲染器 + 呼吸图 Mesh)、打开呼吸图并加载分层与位移场、
参数表里每个参数都有滑条且值 = 盘上的值、拖滑条立刻生效 / 标脏 / 标橙 / 未保存提示、参数文本往返、游戏的呼吸图着色按表演真把纸挪动
(接入层离屏异步回读;行序自上而下)、按住看原图 = 静止帧、画布预览非空、对话图里那一段剧情原样走完(渐弱等停住、猛吸、收掉)、
导出到游戏写盘 / 烘焙产物拒存、推给游戏软失败、出一口循环 GIF(离屏逐帧读回)。

自检进程整个读写指在临时样例工程(`app.py` / `--serve --fixture`):真工程的呼吸图目录必须逐字节不变、出片目录不许多东西。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.workbench_rhi import browser  # noqa: E402

_DIR = _ROOT / "public" / "assets" / "data" / "breathing"
_RENDERS = _ROOT / "local" / "breathing_renders"


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _fingerprint() -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(_DIR.glob("*.json"))} if _DIR.is_dir() else {}


def _renders() -> set:
    return {p.name for p in _RENDERS.iterdir()} if _RENDERS.is_dir() else set()


@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_interaction_layer_selftest() -> None:
    before, renders_before = _fingerprint(), _renders()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.breathing_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    assert _fingerprint() == before, "自检改动了真工程的呼吸图目录"
    assert _renders() == renders_before, "自检把片子出到了真工程里"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时(看上面的报告)"
    assert "passed, 0 failed" in r.stdout
    assert "PASS S1" in r.stdout and "PASS S16" in r.stdout
    # 画面那几条:这个宿主拿得到 WebGPU 就必须 PASS,拿不到就必须是写明原因的 SKIP(不许悄悄没了)
    for key in ("S10 游戏的呼吸图着色", "S11 按住看原图", "S17 出一口循环", "S17 同参数出两次片"):
        assert f"PASS {key}" in r.stdout or f"SKIP {key}" in r.stdout, key


_SELFTEST_JS = _ROOT / "tools" / "breathing_workbench" / "viewer" / "tests" / "selftest.js"


def _fixture_server(tmp_path: Path):
    # 目录名带 breathwb_selftest_:自检脚本凭它(与 /api/boot 的 real === false)自证读写不在真库
    proj = tmp_path / "breathwb_selftest_chrome"
    return browser.serving([sys.executable, "-m", "tools.breathing_workbench", "--serve", "--port", "{port}", "--fixture", str(proj)])


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu(tmp_path: Path) -> None:
    """同一份自检在真 GPU 的 Chrome 里:画面那几条(游戏的 WebGPU 渲染器 + 呼吸图 Mesh、离屏回读、出片)全部真跑,一条 SKIP 都不许有。"""
    before, renders_before = _fingerprint(), _renders()
    with _fixture_server(tmp_path) as base:
        r = browser.run_page(base + "/", selftest=_SELFTEST_JS, no_skip=True)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert _fingerprint() == before, "自检改动了真工程的呼吸图目录"
    assert _renders() == renders_before, "自检把片子出到了真工程里"
    assert "WebGPU 适配器:没有" not in r.stdout and "WebGPU 适配器：没有" not in r.stdout, "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error(看上面的报告)"
    assert " 0 failed, 0 skipped" in r.stdout
    for key in ("S1 画面是游戏同一个 WebGPU 渲染器", "S10 游戏的呼吸图着色", "S10 回读自上而下", "S11 按住看原图", "S11 画布预览", "S17 出一口循环",
                "S17 同参数出两次片"):
        assert f"PASS {key}" in r.stdout, key


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_page_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟:Chrome 打开呼吸工作台,拿到 WebGPU、画面非空(与清屏色不同的像素够多)、控制台无 error。"""
    shot = tmp_path / "breathing_workbench_smoke.png"
    with _fixture_server(tmp_path) as base:
        r = browser.run_page(base + "/", smoke=True, shot=shot)
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过(看上面)"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
