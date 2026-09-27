# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

这是审查循环里反复踩到的那些坑的固化版（新开资产第一笔手势、保存后改数值、在飞的烘焙 / 保存竞态、
换场景与撤销重做的现场同步、装载门、渲染只读、手势跨 doc……）。改了 viewer 下任何东西先跑它。
需要 PySide6 QtWebView（WebView2 / WKWebView：桌面壳走 run_desktop(webgpu=True)）+ 工程真数据（雾津街头）；缺一个就 skip。约 1–2 分钟。
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
_SCENE_OK = (_ROOT / "public" / "assets" / "scenes" / "雾津街头.json").is_file() and \
    (_ROOT / "public" / "resources" / "runtime" / "scenes" / "雾津街头" / "background.png").is_file()
_COIN = _ROOT / "public" / "assets" / "data" / "trajectories" / "coin_drop_demo.json"



@pytest.mark.skipif(not (_SCENE_OK and _COIN.is_file()), reason="缺工程真数据")
@pytest.mark.skipif(bool(browser.qt_host_unavailable()), reason=browser.qt_host_unavailable() or "ok")
def test_interaction_layer_selftest() -> None:
    before = _COIN.read_bytes()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.trajectory_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    assert _COIN.read_bytes() == before, "自检不许改 coin_drop_demo"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
    assert "passed, 0 failed" in r.stdout
    # 3D 视图走接入层的 3D 调试件（WebGPU）：Qt 宿主是 WebView2（run_desktop(webgpu=True)），着色那几条也真跑、不许 SKIP
    assert "PASS S1g the 3D view holds no WebGL context" in r.stdout
    assert not browser.skip_lines(r.stdout), f"Qt（WebGPU）宿主里不许有 SKIP：{browser.skip_lines(r.stdout)}"


# ---------------------------------------------------------------------------------------------------------------------
# 真 GPU 的 Chrome（3D 视图的着色层 = 接入层的 3D 调试件，RHI / WebGPU）：与 Qt（WebView2）宿主同一份自检，
# 两边都不许有 SKIP，另有一条冒烟（切到 3D、画面非空、控制台无 error、存截图）。没有 node / playwright-core / Chrome 就 skip。


_SELFTEST_JS = _ROOT / "tools" / "trajectory_workbench" / "viewer" / "tests" / "selftest.js"
#: 轨迹台缺省开在 2D 原画视图、页面不设 __ready：冒烟等资产与背景装好，切到 3D 再判
_SMOKE_READY = "typeof S !== 'undefined' && !!(S.doc && S.bgImage && !(S.busy > 0))"
_SMOKE_CHECK = ("(() => { if (typeof v3 === 'undefined' || !v3) return { ok: false, detail: 'no v3' };"
                " if (!v3.gpu) return { ok: false, detail: v3.gpuErr || 'gpu pending' };"
                " if (S.view !== '3d') setView('3d'); v3.draw();"
                " const n = v3.gpu.countDrawnPixels(); return { ok: !!v3.mesh && n > 20000 && !v3.gpu.lastError,"
                " detail: { drawn: n, draws: v3.gpu.stats.draws, err: v3.gpu.lastError } }; })()")


def _serve():
    return browser.serving([sys.executable, "-m", "tools.trajectory_workbench", "--serve", "--port", "{port}"])


@pytest.mark.skipif(not (_SCENE_OK and _COIN.is_file()), reason="缺工程真数据")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu() -> None:
    """同一份 selftest.js 在真 GPU 的 Chrome 里：S1g（画面非空 / 活动段标记颜色落在页面投影处 / 网格前后探针的深度遮挡 /
    幽灵卡片贴图公告板）真跑真过。"""
    before = _COIN.read_bytes()
    with _serve() as base:
        r = browser.run_page(base + "/", selftest=_SELFTEST_JS, no_skip=True)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert _COIN.read_bytes() == before, "自检不许改 coin_drop_demo"
    assert "WebGPU 适配器：没有" not in r.stdout, "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error（看上面的报告）"
    assert " 0 failed, 0 skipped" in r.stdout
    assert "PASS S1g depth:" in r.stdout and "PASS S1g the ghost card" in r.stdout and "PASS S1g a marker reads back" in r.stdout


@pytest.mark.skipif(not (_SCENE_OK and _COIN.is_file()), reason="缺工程真数据")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_view3d_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟：Chrome 打开轨迹工作台、切到 3D，拿到 WebGPU、画面非空、控制台无 error；截图留在 tmp。"""
    shot = tmp_path / "trajectory_view3d_smoke.png"
    with _serve() as base:
        r = browser.run_page(base + "/", smoke=True, shot=shot, extra=["--ready", _SMOKE_READY, "--check", _SMOKE_CHECK])
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过（看上面）"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
