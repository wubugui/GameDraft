# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

这是审查循环里反复踩到的那些坑的固化版（新开资产第一笔手势、保存后改数值、在飞的烘焙 / 保存竞态、
换场景与撤销重做的现场同步、装载门、渲染只读、手势跨 doc……）。改了 viewer 下任何东西先跑它。
需要 PySide6 + QtWebEngine + 工程真数据（雾津街头）；缺一个就 skip。约 1–2 分钟。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_SCENE_OK = (_ROOT / "public" / "assets" / "scenes" / "雾津街头.json").is_file() and \
    (_ROOT / "public" / "resources" / "runtime" / "scenes" / "雾津街头" / "background.png").is_file()
_COIN = _ROOT / "public" / "assets" / "data" / "trajectories" / "coin_drop_demo.json"


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not (_SCENE_OK and _COIN.is_file()), reason="缺工程真数据")
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
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
