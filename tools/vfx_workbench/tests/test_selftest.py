# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

覆盖：启动、**坐标对齐自证**（运行时 groundWorldAt / shellContactAt 对工作台与服务端）、**手性**
（相机的右投到屏幕 +x、原画的右 / 上与屏幕同向）、Unity 式相机手势（环视机位不动 / 环绕目标不动 /
朝光标缩放光标下点不动 / 飞行键不漏给工具键表 / 正交下仍能拾取）、gizmo（选中立刻有 / 单轴只动一个分量 /
Ctrl 吸附整数倍 / 纯点一下不入历史 / 2D 原画里同一份）、新开资产第一笔手势进历史、群体半径缩放、
锚点与玩家与刺激、**本地预览确定性**（同种子逐帧相同）、保存往返与保存锁、装载门、护栏、联动软失败、
**布置（S18）**：时段外观切换换背景、布置到这里→存盘键序、2D / 3D 拉区域、选中顶点立刻有 gizmo、gizmo 只动一个点、
双击插点 / Delete / 右键删点、撤销覆盖布置、预览 sim 收到 area + confine、publish 只带修改范围与切时段请求、存一半不清脏。
另跑 scoped-save-selftest.js，验证只编辑跑马梁时保存、预览、撤销均不提交未编辑的茶馆。

需要 PySide6 + QtWebEngine + 工程真数据（至少一个烘过深度的场景）；缺一个就 skip。约 10 秒。

原画视图与雷的现画预览是游戏同一个 WebGPU 渲染器（工作台 RHI 接入层 + 游戏的 `VfxRenderer`）：offscreen 的 QtWebEngine
拿不到 WebGPU 适配器，那几条在桌面壳里记 SKIP（写明原因）；**同一份脚本**再在真 GPU 的 Chrome 里跑一遍
（`tools/workbench_rhi/chrome_page.mjs --selftest … --no-skip`，服务开 `--serve --selftest-sandbox`），一条 SKIP 都不许有。
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
_VFX = _ROOT / "public" / "assets" / "data" / "vfx"
_SCENE = "bridge_underpass"
_SCENE_OK = (_ROOT / "public" / "assets" / "scenes" / f"{_SCENE}.json").is_file() and \
    (_ROOT / "public" / "resources" / "runtime" / "scenes" / _SCENE / "raw_depth_rg.png").is_file()


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


_LIB = _ROOT / "public" / "assets" / "data" / "vfx_placements.json"
_LS = _ROOT / "public" / "assets" / "data" / "vfx_lightning_styles.json"
_LS_OUT = _ROOT / "public" / "resources" / "runtime" / "images" / "vfx" / "lightning"


def _fingerprint() -> dict:
    fp = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(_VFX.glob("*.json"))}
    # 布置库：自检进程把读写指到临时拷贝（app.py），真库必须逐字节不动
    fp["<vfx_placements.json>"] = hashlib.sha256(_LIB.read_bytes()).hexdigest() if _LIB.is_file() else None
    # 雷电样式库与生成目录：自检进程同样指到临时拷贝（app.py），真的必须逐字节不动、不多不少
    fp["<vfx_lightning_styles.json>"] = hashlib.sha256(_LS.read_bytes()).hexdigest() if _LS.is_file() else None
    fp["<lightning outputs>"] = sorted(str(p.relative_to(_LS_OUT)) for p in _LS_OUT.rglob("*")) if _LS_OUT.is_dir() else None
    return fp


#: 页内自检脚本（桌面壳与真 GPU 的 Chrome 跑同一份）
_SCRIPTS = (
    "tools/vfx_workbench/viewer/tests/selftest.js", "tools/vfx_workbench/viewer/tests/scoped-save-selftest.js",
    "tools/vfx_workbench/viewer/tests/pipeline-selftest.js", "tools/vfx_workbench/viewer/tests/timing-selftest.js",
    # 光柱：加光柱 / 选中立刻有 gizmo / 原画视图真实预览（游戏的 VfxRenderer）/ 从画布拖把手 / 检视器 / 尘埃挂光柱 / 存盘往返 / 改名删除 / 平面近似
    "tools/vfx_workbench/viewer/tests/beam-selftest.js",
    # 雷电样式：检视器一节 / 现画预览真画出了雷（游戏的模拟 + VfxRenderer）/ 改参数只脏样式库 / 撤销 / 换样式 / 效果没存拒套用 / 套用写 bolts 后重开 / 样式层锁宽度 / 同步给同组
    "tools/vfx_workbench/viewer/tests/lightning-selftest.js",
    # 表面材质区：工具条按钮 / 2D 里真拖出一块水面 / 顶点微移加点删点 / 检视器改种类反光可撤 / 预览只带本场景 surfaces / 存盘删光
    "tools/vfx_workbench/viewer/tests/surface-selftest.js",
    # 原画视图的 GPU 画面：游戏的 WebGPU 渲染器、没有自己的着色器、标注层、纸钱 / 落雷真画出来、图层开关、原画深度、换场景放掉旧背景
    "tools/vfx_workbench/viewer/tests/gpu2d-selftest.js",
)


@pytest.mark.skipif(not (_SCENE_OK and _VFX.is_dir()), reason="缺工程真数据（烘过深度的场景 / 效果库）")
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_interaction_layer_selftest() -> None:
    # 真实页面用例串行，避免临时效果的指纹检查互相干扰。
    for script in _SCRIPTS:
        before = _fingerprint()
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
        r = subprocess.run([sys.executable, "-m", "tools.vfx_workbench", "--selftest", script], cwd=str(_ROOT),
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr[-4000:])
        after = _fingerprint()
        # 自检只在 zz_selftest_* 上存盘并在收尾删掉：工程真资产必须逐字节回到原样，且没留下临时文件
        assert after == before, f"自检改动了工程效果资产（或临时资产没删干净）：{set(after) ^ set(before) or '内容变了'}"
        assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
        assert "passed, 0 failed" in r.stdout


def _sandbox_server(tmp: Path):
    """工作台裸服务 + 自检沙箱（布置库 / 样式库拷到 pytest 的临时目录、游戏地址钉死端口）；效果目录是真的，自检只建 / 删 zz_selftest_*。
    沙箱目录给 pytest 的 tmp_path：服务子进程在 Windows 上是被硬结束的，它自己的收尾不跑。"""
    return browser.serving([sys.executable, "-m", "tools.vfx_workbench", "--serve", "--port", "{port}",
                            "--selftest-sandbox", str(tmp / "sandbox")])


@pytest.mark.skipif(not (_SCENE_OK and _VFX.is_dir()), reason="缺工程真数据（烘过深度的场景 / 效果库）")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
@pytest.mark.parametrize("script", _SCRIPTS, ids=[Path(s).stem for s in _SCRIPTS])
def test_selftest_in_chrome_with_real_webgpu(script: str, tmp_path: Path) -> None:
    """同一份自检在真 GPU 的 Chrome 里：原画视图 / 雷预览（游戏的 WebGPU 渲染器 + VfxRenderer）每一条都真跑，一条 SKIP 都不许有。"""
    before = _fingerprint()
    with _sandbox_server(tmp_path) as base:
        # 自检故意发的坏请求（护栏：/api/validate 拒收非法效果、外部改过拒存）服务端回 500，浏览器记一条
        # 「Failed to load resource … 500」——断言由自检自己做；未捕获异常 / 别的控制台 error 照样算失败
        r = browser.run_page(base + "/", selftest=_ROOT / script, no_skip=True,
                             extra=["--allow", "^Failed to load resource: the server responded with a status of 500"])
    sys.stdout.write(r.stdout[-8000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    after = _fingerprint()
    assert after == before, f"自检改动了工程效果资产（或临时资产没删干净）：{set(after) ^ set(before) or '内容变了'}"
    assert "WebGPU 适配器：没有" not in r.stdout, "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error（看上面的报告）"
    assert " 0 failed, 0 skipped" in r.stdout


@pytest.mark.skipif(not (_SCENE_OK and _VFX.is_dir()), reason="缺工程真数据（烘过深度的场景 / 效果库）")
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_page_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟：Chrome 打开粒子工作台、切到原画视图：拿到 WebGPU、GPU 画面非空（背景 + 粒子）、控制台无 error。"""
    shot = tmp_path / "vfx_workbench_smoke.png"
    with _sandbox_server(tmp_path) as base:
        r = browser.run_page(base + "/", smoke=True, shot=shot,
                             extra=["--check", "(setView(2), window.__rhiSmoke2d())"])
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过（看上面）"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
