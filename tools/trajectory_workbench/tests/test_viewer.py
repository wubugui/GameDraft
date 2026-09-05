# -*- coding: utf-8 -*-
"""前端逻辑门：用 node 跑 viewer/tests/math.test.cjs（样条 / 抛体正反解 / 射线 / Edit 规范化 / History）。

没有 node 的机器直接 skip——但仓库开发机都有（scripts/pytool.cjs 就靠它）。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_TEST = _HERE.parent / "viewer" / "tests" / "math.test.cjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="没有 node")
def test_viewer_math_in_node() -> None:
    r = subprocess.run(["node", str(_TEST)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    assert r.returncode == 0, r.stderr[-2000:]
    assert "passed" in r.stdout


def test_viewer_files_reference_each_other_in_order() -> None:
    """index.html 装载顺序：common → history → edit → view2d → view3d → app（后者引用前者的全局）。"""
    html = (_HERE.parent / "viewer" / "index.html").read_text(encoding="utf-8")
    order = [html.index(f"/viewer/{n}.js") for n in ("common", "history", "edit", "view2d", "view3d", "app")]
    assert order == sorted(order)
    assert "cache" not in html.lower().replace("no-cache", "")   # 页面本身不引任何缓存机制（localStorage 等）
    for name in ("app.js", "view2d.js", "view3d.js", "edit.js", "common.js", "history.js"):
        src = (_HERE.parent / "viewer" / name).read_text(encoding="utf-8")
        assert "localStorage" not in src and "sessionStorage" not in src and "indexedDB" not in src, name


def test_inspector_forms_do_not_write_defaults_into_doc() -> None:
    """检视器渲染必须只读：`seg.x = seg.x || {...}` 这种"顺手补缺省"会把 `tracks:{}` 之类写进文件（审查第七轮后抓到）。"""
    src = (_HERE.parent / "viewer" / "app.js").read_text(encoding="utf-8")
    a = src.index("function renderManualForm(")
    b = src.index("function easingSel(")
    c = src.index("function timingEditor(")
    d = src.index("function evalTiming(")
    body = src[a:b] + src[c:d]   # 检视器两张表单 + 时间曲线小编辑器（它在渲染时也会被调）
    for bad in ("seg.path = seg.path ||", "seg.timing = seg.timing ||", "seg.tracks = seg.tracks ||", "seg.v0 = seg.v0 ||", "seg.stop = seg.stop ||", "seg.spin = seg.spin ||", "seg.start = seg.start ||", "seg.timing.keys = ("):
        assert bad not in body, bad
    assert "ensureManual(" in body and "ensurePhysics(" in body
    # 时间曲线小编辑器的 keys()/dur() 必须是纯读（排序副本），任何"顺手赋值"都不行
    assert "const keys = () => (((seg.timing || {}).keys) || []).slice().sort(" in body
    assert "const dur = () => Math.max(1, num((seg.timing || {}).durationMs, 1000));" in body
    # ensure* 只建空容器：行为缺省（停机阈值等）归烘焙机，UI 不能借"补容器"改烘焙口径
    assert "seg.stop = seg.stop || {}" in src
