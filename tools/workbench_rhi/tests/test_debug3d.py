# -*- coding: utf-8 -*-
"""工作台 RHI 接入层 · 3D 调试件：包打得出来（入口命名空间 ``debug3d``、着色器打进去、第二次一个字节不写）；
四个工作台的 3D 视图页面里不再有 WebGL 上下文、不再拼 GLSL，都走 ``/gen/debug3d.bundle.js``。

真 GPU 的像素断言在各工作台的自检里（Chrome 真跑，见各台 ``tests/test_selftest.py``）；无 GPU 的命令流 / 几何单测在
``tools/workbench_rhi/debug3d.test.ts``（vitest）。没有 node 就 skip 打包那一条。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.workbench_rhi import build as wbrhi  # noqa: E402
from tools.workbench_rhi import debug3d_bundle  # noqa: E402

_HAS_NODE = wbrhi.node_exe() is not None and (_ROOT / "node_modules" / "vite").is_dir()
_WORKBENCHES = ("vfx", "terrain", "acoustic", "trajectory")
_GLSL = re.compile(r"getContext\(\s*['\"](?:webgl2?|experimental-webgl)['\"]|#version\s+300|gl_Position|gl_FragColor|gl_PointSize|createShader\(|shaderSource\(")


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node 或仓库根没有 node_modules/vite")
def test_bundle_builds_once_and_carries_the_shader(tmp_path: Path) -> None:
    gen = tmp_path / "_gen"
    p, err = debug3d_bundle.ensure(gen)
    assert p is not None and not err, err
    js = p.read_text(encoding="utf-8")
    assert "createView" in js and "Debug3DView" in js and "glToWebGpuClip" in js
    assert "fn vs_point" in js and "fn vs_wide" in js and "fn fs_vcolor" in js   # debug3d.wgsl 经 ?raw 打进去
    inputs = {Path(x).name for x in wbrhi.inputs_of(p)}
    assert {"debug3d.ts", "debug3d.wgsl"} <= inputs
    m0 = p.stat().st_mtime_ns
    p2, err2 = debug3d_bundle.ensure(gen)
    assert p2 == p and not err2 and p.stat().st_mtime_ns == m0, "源没变却重打了"
    assert debug3d_bundle.paths(gen)[0].read_text(encoding="utf-8").count("export * as debug3d from") == 1


def test_view3d_pages_have_no_webgl_or_glsl() -> None:
    for w in _WORKBENCHES:
        src = (_ROOT / "tools" / f"{w}_workbench" / "viewer" / "view3d.js").read_text(encoding="utf-8")
        hits = _GLSL.findall(src)
        assert not hits, f"{w} 的 view3d.js 还在用 WebGL / GLSL：{hits}"
        assert debug3d_bundle.ROUTE in src, f"{w} 的 view3d.js 没走 3D 调试件（{debug3d_bundle.ROUTE}）"


def test_every_view3d_workbench_serves_the_bundle() -> None:
    for w in _WORKBENCHES:
        src = (_ROOT / "tools" / f"{w}_workbench" / "serve.py").read_text(encoding="utf-8")
        assert "debug3d_bundle.ROUTE" in src and "debug3d_bundle.ensure(" in src, f"{w} 的 serve.py 没有 3D 调试件的路由"
