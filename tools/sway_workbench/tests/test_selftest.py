# -*- coding: utf-8 -*-
"""交互层端到端回归门:无头桌面壳里跑真页面 + ``viewer/tests/selftest.js``。

覆盖的是**制作人真踩过的那几条**:橡皮只擦当前层、撤销要整笔还回来、清空只清当前层且可撤、
叠画另一层不冲淡先前那层(canvas 预乘坑)、四层导出的是不透明灰度(数据不放 alpha)、导出再装回来量对得上。

跑完会核对烘焙目录的指纹:**这道门绝不许改动盘上的拆层产物**。
需要 PySide6 + QtWebEngine + 一个烘过拆层的场景;缺一个就 skip。约 20 秒。
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_SCENE = "跑马梁"
_BAKE = _ROOT / "public" / "resources" / "runtime" / "scenes" / _SCENE / "lighting" / "background"
_BAKED = (_BAKE / "sway.json").is_file()


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:                                    # noqa: BLE001 — 没装就跳过,不是失败
        return False


def _fingerprint() -> dict:
    if not _BAKE.is_dir():
        return {}
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(_BAKE.glob("sway*")) if p.is_file()}


@pytest.mark.skipif(not _has_webengine(), reason="没有 QtWebEngine")
def test_桌面壳起得来():
    """主入口是**桌面应用**,不是 `--serve` + 浏览器。只测后者的话,壳这一层坏了没人知道。"""
    proc = subprocess.run(
        [sys.executable, "-m", "tools.sway_workbench", "--smoke"],
        cwd=str(_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, "桌面壳起不来:" + out[-2000:]
    assert "loadFinished ok=True" in out, "页面没加载成功:" + out[-2000:]


@pytest.mark.skipif(not _has_webengine(), reason="没有 QtWebEngine")
@pytest.mark.skipif(not _BAKED, reason=f"{_SCENE} 还没烘过拆层")
def test_交互层端到端回归():
    before = _fingerprint()
    proc = subprocess.run(
        [sys.executable, "-m", "tools.sway_workbench", "--selftest"],
        cwd=str(_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    assert "FAIL" not in out and "EXC " not in out, f"自检有失败:\n{out[-3000:]}"
    assert proc.returncode == 0, f"自检退出码 {proc.returncode}:\n{out[-3000:]}"
    assert _fingerprint() == before, "自检动了盘上的拆层产物——它只许在内存里涂"
