# -*- coding: utf-8 -*-
"""交互层端到端回归门:无头桌面壳(offscreen + ANGLE/SwiftShader WebGL2)里跑真页面 + `viewer/tests/selftest.js`。

覆盖:自检工程自证、打开呼吸图并加载分层与位移场、参数表里每个参数都有滑条且值 = 盘上的值、拖滑条立刻生效 / 标脏 / 标橙 /
未保存提示、参数文本往返、同一份着色器按表演真把纸挪动(读像素)、按住看原图 = 静止帧、对话图里那一段剧情原样走完
(渐弱等停住、猛吸、收掉)、导出到游戏写盘 / 烘焙产物拒存、推给游戏软失败、出一口循环 GIF。

自检进程整个读写指在临时样例工程(`app.py`):真工程的呼吸图目录必须逐字节不变、出片目录不许多东西。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
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
    assert "PASS S1" in r.stdout and "PASS S17" in r.stdout
