# -*- coding: utf-8 -*-
"""交互层端到端回归门：无头桌面壳（offscreen + ANGLE/SwiftShader WebGL2）里跑真页面 + `viewer/tests/selftest.js`。

覆盖：启动只有模板没有场景、「用在哪」列出全部宿主、模板预览是运行时本体且按真实尺寸摆（同样的事件半尺寸烧得更快）、
检视器数值保值（整数 / 越界 / 清空删键 / 必填）、真实尺寸锁比例 / 解锁 / 偏离提示 / 必填、着火点与握点增删拖（撤销重做）、
燃料涂层笔刷（写 data URL、网格跟着变、撤销重做重解码）、预览推进 / 时间轴确定性重放 / 熄灭 / 复原 / 消耗燃烧 / 预览风吹熄、
同一份 burnShade.glsl 真画出焦黑烧没自发光（读像素；没点的不挂着色）、只读场景视图（一个模拟里各用各的模板、透视与朝向口径、
initial 在烧、拖不动、当前模板用工作态、跨实例蔓延）、左右站位残差≈0 与朝向、接触帧没标 / 片段不存在 / 状态点不了的显式提示、
本地能不能站 + 游戏判定覆盖本地、保存（值、浮点表示、没改不写、保存锁、别处改过拒写）、新建（尺寸必填、选图给初始尺寸）/ 复制 / 换图 /
改名（先确认、跟着改所有引用）/ 删除（有引用拒绝）、非法与重名 id、联动协议 v2（载荷形状、从游戏回传的实例里选用这份模板的）、视图手势。

自检进程整个读写指在临时样例工程（`app.py`）：真工程的模板目录必须逐字节不变，真工程里也不许出现自检改名用的 id。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_BURN = _ROOT / "public" / "assets" / "data" / "burnables"
_ASSETS = _ROOT / "public" / "assets"
_SELFTEST_RENAME_ID = b"zz_paper_renamed"


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _fingerprint() -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(_BURN.glob("*.json"))} if _BURN.is_dir() else {}


def _real_files_mentioning_selftest_id() -> list[str]:
    out = []
    for p in _ASSETS.rglob("*.json"):
        try:
            if _SELFTEST_RENAME_ID in p.read_bytes():
                out.append(p.as_posix())
        except OSError:
            continue
    return out


@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_interaction_layer_selftest() -> None:
    before = _fingerprint()
    assert not _real_files_mentioning_selftest_id(), "真工程里本来就有自检改名用的 id：换一个"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.burn_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    after = _fingerprint()
    assert after == before, f"自检改动了真工程的模板目录：{set(after) ^ set(before) or '内容变了'}"
    leaked = _real_files_mentioning_selftest_id()
    assert not leaked, f"自检的改名写进了真工程：{leaked}"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
    assert "passed, 0 failed" in r.stdout
    assert "[selftest]" in r.stdout and "PASS S1" in r.stdout and "PASS S14" in r.stdout
