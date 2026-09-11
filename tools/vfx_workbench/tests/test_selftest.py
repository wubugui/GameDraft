# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

覆盖：启动、**坐标对齐自证**（运行时 groundWorldAt / shellContactAt 对工作台与服务端）、**手性**
（相机的右投到屏幕 +x、原画的右 / 上与屏幕同向）、Unity 式相机手势（环视机位不动 / 环绕目标不动 /
朝光标缩放光标下点不动 / 飞行键不漏给工具键表 / 正交下仍能拾取）、gizmo（选中立刻有 / 单轴只动一个分量 /
Ctrl 吸附整数倍 / 纯点一下不入历史 / 2D 原画里同一份）、新开资产第一笔手势进历史、群体半径缩放、
锚点与玩家与刺激、**本地预览确定性**（同种子逐帧相同）、保存往返与保存锁、装载门、护栏、联动软失败。

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


def _fingerprint() -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(_VFX.glob("*.json"))}


@pytest.mark.skipif(not (_SCENE_OK and _VFX.is_dir()), reason="缺工程真数据（烘过深度的场景 / 效果库）")
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_interaction_layer_selftest() -> None:
    before = _fingerprint()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.vfx_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    after = _fingerprint()
    # 自检只在 zz_selftest_* 上存盘并在收尾删掉：工程真资产必须逐字节回到原样，且没留下临时文件
    assert after == before, f"自检改动了工程效果资产（或临时资产没删干净）：{set(after) ^ set(before) or '内容变了'}"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
    assert "passed, 0 failed" in r.stdout
