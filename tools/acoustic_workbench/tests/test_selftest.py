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
