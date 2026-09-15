# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳里跑真页面 + `viewer/tests/selftest.js`。

覆盖：启动、**页面合成 == 服务端合成**（逐格）、手性、Unity 式相机手势、笔刷 / 多边形 / 矩形 / 高度 / 检视工具、
gizmo 与顶点、撤销 / 重做、保存往返（隔离到临时树）、推给游戏（游戏指到死端口：合成成功、通知失败不算失败）、
历史、草稿、连通性判据、顶视 / 原画视图一致。约 15 秒。需要 PySide6 + QtWebEngine + 工程真数据（bridge_underpass）。
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
_SCENE = "bridge_underpass"
_RT = _ROOT / "public" / "resources" / "runtime" / "scenes" / _SCENE
_SCENE_OK = (_ROOT / "public" / "assets" / "scenes" / f"{_SCENE}.json").is_file() and (_RT / "raw_depth_rg.png").is_file() \
    and (_RT / "terrain" / "terrain.json").is_file()


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _fingerprint() -> dict:
    fp = {}
    for p in sorted([*_RT.glob("terrain/*"), _RT / "collision.png", _RT / "collision.json", *(_RT / "lighting").glob("*/ground_d.png"),
                     *(_RT / "lighting").glob("*/lighting.json")]):
        if p.is_file():
            fp[str(p.relative_to(_RT))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return fp


@pytest.mark.skipif(not _SCENE_OK, reason="缺工程真数据（bridge_underpass 的深度 / 作者层）")
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
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
