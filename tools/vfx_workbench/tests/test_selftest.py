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
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
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


def _fingerprint() -> dict:
    fp = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(_VFX.glob("*.json"))}
    # 布置库：自检进程把读写指到临时拷贝（app.py），真库必须逐字节不动
    fp["<vfx_placements.json>"] = hashlib.sha256(_LIB.read_bytes()).hexdigest() if _LIB.is_file() else None
    return fp


@pytest.mark.skipif(not (_SCENE_OK and _VFX.is_dir()), reason="缺工程真数据（烘过深度的场景 / 效果库）")
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_interaction_layer_selftest() -> None:
    # 两个真实页面用例串行，避免临时效果的指纹检查互相干扰。
    for script in ("tools/vfx_workbench/viewer/tests/selftest.js", "tools/vfx_workbench/viewer/tests/scoped-save-selftest.js", "tools/vfx_workbench/viewer/tests/pipeline-selftest.js", "tools/vfx_workbench/viewer/tests/timing-selftest.js",
                   # 光柱：加光柱 / 选中立刻有 gizmo / 原画视图真实预览 / 从画布拖把手 / 检视器 / 尘埃挂光柱 / 存盘往返 / 改名删除 / 平面近似
                   "tools/vfx_workbench/viewer/tests/beam-selftest.js"):
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
