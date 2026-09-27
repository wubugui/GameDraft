# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

覆盖：启动、**页面合成 == 服务端合成**（逐格）、手性、Unity 式相机手势、笔刷 / 多边形 / 矩形 / 高度 / 检视工具、
gizmo 与顶点、撤销 / 重做、保存往返（隔离到临时树）、推给游戏（游戏指到死端口：合成成功、通知失败不算失败）、
历史、草稿、连通性判据、顶视 / 原画视图一致。约 15 秒。需要 PySide6 QtWebView（WebView2 / WKWebView：桌面壳走 run_desktop(webgpu=True)）+ 工程真数据（bridge_underpass）。
真作者层 / 资源 **逐字节不动**（app.py 把合成器的场景根、预览、草稿全指到临时树）。
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
_SCENE = "bridge_underpass"
_RT = _ROOT / "public" / "resources" / "runtime" / "scenes" / _SCENE
_SCENE_OK = (_ROOT / "public" / "assets" / "scenes" / f"{_SCENE}.json").is_file() and (_RT / "raw_depth_rg.png").is_file() \
    and (_RT / "terrain" / "terrain.json").is_file()



def _fingerprint() -> dict:
    fp = {}
    for p in sorted([*_RT.glob("terrain/*"), _RT / "collision.png", _RT / "collision.json", *(_RT / "lighting").glob("*/ground_d.png"),
                     *(_RT / "lighting").glob("*/lighting.json")]):
        if p.is_file():
            fp[str(p.relative_to(_RT))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return fp


@pytest.mark.skipif(not _SCENE_OK, reason="缺工程真数据（bridge_underpass 的深度 / 作者层）")
@pytest.mark.skipif(bool(browser.qt_host_unavailable()), reason=browser.qt_host_unavailable() or "ok")
def test_interaction_layer_selftest() -> None:
    before = _fingerprint()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.terrain_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    after = _fingerprint()
    assert after == before, f"自检改动了工程真数据：{set(after) ^ set(before) or '内容变了'}"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
    assert "passed, 0 failed" in r.stdout
    # 3D 视图走接入层的 3D 调试件（WebGPU）：Qt 宿主是 WebView2（run_desktop(webgpu=True)），着色那几条也真跑、不许 SKIP
    assert "PASS S1g the 3D view holds no WebGL context" in r.stdout
    assert not browser.skip_lines(r.stdout), f"Qt（WebGPU）宿主里不许有 SKIP：{browser.skip_lines(r.stdout)}"


# ---------------------------------------------------------------------------------------------------------------------
# 真 GPU 的 Chrome（3D 视图的着色层 = 接入层的 3D 调试件，RHI / WebGPU）：与 Qt（WebView2）宿主同一份自检，
# 两边都不许有 SKIP，另有一条冒烟（画面非空、控制台无 error、存截图）。没有 node / playwright-core / Chrome 就 skip。


_SELFTEST_JS = _ROOT / "tools" / "terrain_workbench" / "viewer" / "tests" / "selftest.js"
_SMOKE_CHECK = ("(() => { if (typeof v3 === 'undefined' || !v3) return { ok: false, detail: 'no v3' };"
                " if (!v3.gpu) return { ok: false, detail: v3.gpuErr || 'gpu pending' }; v3.draw();"
                " const n = v3.gpu.countDrawnPixels(); return { ok: !!v3.mesh && !!v3.cells && n > 20000 && !v3.gpu.lastError,"
                " detail: { drawn: n, draws: v3.gpu.stats.draws, err: v3.gpu.lastError } }; })()")


def _serve_isolated(tmp_path: Path):
    # 与 --selftest 同样的隔离：作者层 / 预览 / 草稿指到临时树、游戏地址指死端口
    return browser.serving([sys.executable, "-m", "tools.terrain_workbench", "--serve", "--port", "{port}",
                            "--selftest-env", str(tmp_path / "iso")])


@pytest.mark.skipif(not _SCENE_OK, reason="缺工程真数据（bridge_underpass 的深度 / 作者层）")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu(tmp_path: Path) -> None:
    """同一份 selftest.js 在真 GPU 的 Chrome 里：S1g（画面非空 / 标记颜色落在页面投影处 / 网格前后探针的深度遮挡 / 碰撞格顶点色）真跑真过。"""
    before = _fingerprint()
    with _serve_isolated(tmp_path) as base:
        r = browser.run_page(base + "/", selftest=_SELFTEST_JS, no_skip=True)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert _fingerprint() == before, "自检改动了工程真数据"
    assert "WebGPU 适配器：没有" not in r.stdout, "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error（看上面的报告）"
    assert " 0 failed, 0 skipped" in r.stdout
    assert "PASS S1g depth:" in r.stdout and "PASS S1g collision cells" in r.stdout and "PASS S1g a marker reads back" in r.stdout


@pytest.mark.skipif(not _SCENE_OK, reason="缺工程真数据（bridge_underpass 的深度 / 作者层）")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_view3d_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟：Chrome 打开地形工作台，3D 视图拿到 WebGPU、网格与碰撞格装上、画面非空、控制台无 error；截图留在 tmp。"""
    shot = tmp_path / "terrain_view3d_smoke.png"
    with _serve_isolated(tmp_path) as base:
        r = browser.run_page(base + "/", smoke=True, shot=shot, extra=["--check", _SMOKE_CHECK])
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过（看上面）"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
