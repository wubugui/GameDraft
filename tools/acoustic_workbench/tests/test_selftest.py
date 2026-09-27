# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

覆盖：启动、坐标对齐与手性、渲染只读、真实拖拽加崖壁、Unity 式变换 gizmo（单轴只动一个分量 / Ctrl 吸附整数倍 / 中心贴地 /
绿环 / 等比 / 点只给移动 / 纯点不入历史）+ ▲ 与端点把手各一条历史、Unity 式相机手势（机位不动 / 目标不动 / 光标下点不动 /
飞行键不漏给快捷键表 / 正交视角仍拾取 / 框选 / 双击对准）、检视器数字与滑条、距离缩放 ×10 ⇒ 延迟 ×10、
保存往返与保存锁、复制 / 删除 / 键盘、脏时切空间的页内对话框、无游戏时试听给人话、换场景不丢文档 + 撤销跨换场。
需要 PySide6 + QtWebEngine + 工程真数据（跑马梁已烘深度）；缺一个就 skip。约 13 秒。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_SCENE = "跑马梁"
_SCENE_OK = (_ROOT / "public" / "assets" / "scenes" / f"{_SCENE}.json").is_file() and \
    (_ROOT / "public" / "resources" / "runtime" / "scenes" / _SCENE / "raw_depth_rg.png").is_file()
_SPACES = _ROOT / "public" / "assets" / "data" / "acoustic_spaces.json"


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not (_SCENE_OK and _SPACES.is_file()), reason="缺工程真数据（跑马梁深度 / 空间库）")
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_interaction_layer_selftest() -> None:
    before = _SPACES.read_bytes()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.acoustic_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    # 自检只在 zz_selftest_* 上存盘并在收尾删掉：库文件必须逐字节回到原样
    assert _SPACES.read_bytes() == before, "自检改动了工程空间库（临时空间没删干净？）"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
    assert "passed, 0 failed" in r.stdout
    # 3D 视图走接入层的 3D 调试件：离屏 Qt 拿不到 WebGPU 时着色那几条记 SKIP（带原因），真跑在 Chrome 那条里
    assert "PASS S1g the 3D view holds no WebGL context" in r.stdout


# ---------------------------------------------------------------------------------------------------------------------
# 真 GPU 的 Chrome（3D 视图的着色层 = 接入层的 3D 调试件，RHI / WebGPU）：离屏 Qt 拿不到 WebGPU，那边 S1g 记 SKIP；
# 这里同一份自检不许有 SKIP，另有一条冒烟（画面非空、控制台无 error、存截图）。没有 node / playwright-core / Chrome 就 skip。
# 自检的隔离与桌面壳相同：游戏地址指死端口，临时空间 zz_selftest_* 用完即删（库文件逐字节核）。

if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from tools.workbench_rhi import browser  # noqa: E402

_SELFTEST_JS = _ROOT / "tools" / "acoustic_workbench" / "viewer" / "tests" / "selftest.js"
_SMOKE_CHECK = ("(() => { if (typeof v3 === 'undefined' || !v3) return { ok: false, detail: 'no v3' };"
                " if (!v3.gpu) return { ok: false, detail: v3.gpuErr || 'gpu pending' }; v3.draw();"
                " const n = v3.gpu.countDrawnPixels(); return { ok: !!v3.mesh && n > 20000 && !v3.gpu.lastError,"
                " detail: { drawn: n, draws: v3.gpu.stats.draws, err: v3.gpu.lastError } }; })()")


def _serve():
    return browser.serving([sys.executable, "-m", "tools.acoustic_workbench", "--serve", "--port", "{port}",
                            "--game-url", "http://127.0.0.1:9"])


@pytest.mark.skipif(not (_SCENE_OK and _SPACES.is_file()), reason="缺工程真数据（跑马梁深度 / 空间库）")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu() -> None:
    """同一份 selftest.js 在真 GPU 的 Chrome 里：S1g（画面非空 / 标记颜色落在页面投影处 / 网格前后探针的深度遮挡 / 反射面体）真跑真过。"""
    before = _SPACES.read_bytes()
    with _serve() as base:
        r = browser.run_page(base + "/", selftest=_SELFTEST_JS, no_skip=True)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert _SPACES.read_bytes() == before, "自检改动了工程空间库（临时空间没删干净？）"
    assert "WebGPU 适配器：没有" not in r.stdout, "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error（看上面的报告）"
    assert " 0 failed, 0 skipped" in r.stdout
    assert "PASS S1g depth:" in r.stdout and "PASS S1g reflector bodies" in r.stdout and "PASS S1g a marker reads back" in r.stdout
    # 3D 调试件装上之后页面自己的全局没被依赖库盖掉（「试听」= probe(id)，S8 走它）
    assert "PASS S8 probe explains itself" in r.stdout


@pytest.mark.skipif(not (_SCENE_OK and _SPACES.is_file()), reason="缺工程真数据（跑马梁深度 / 空间库）")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_view3d_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟：Chrome 打开声学工作台，3D 视图拿到 WebGPU、画面非空、控制台无 error；截图留在 tmp。"""
    shot = tmp_path / "acoustic_view3d_smoke.png"
    with _serve() as base:
        r = browser.run_page(base + "/", smoke=True, shot=shot, extra=["--check", _SMOKE_CHECK])
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过（看上面）"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
