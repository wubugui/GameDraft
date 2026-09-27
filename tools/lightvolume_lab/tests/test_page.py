# -*- coding: utf-8 -*-
"""光照体实验室(迁到引擎 RHI 之后)的回归门。

* 静态:页面里没有 WebGL / GLSL;画法只从 ``/gen/lightvol.bundle.js`` 来(预览 = 游戏渲染器,FX = 接入层 ``lightvolFx``)。
* 服务:``/gen/lightvol.bundle.js`` 是 JS 模块、``/api/boot`` 报打包状态、仓库静态照旧(页面 / 游戏资源)。
* 真 GPU 的 Chrome:``tests/selftest.js``(``--no-skip``)——真工程数据的现状(载入照常、烘焙因缺 floor_depth_A/B 抛错)+
  合成场景上 FX 各道算式与 CPU 逐像素复算相符、笔刷 / 脚印 / 雾模拟 / 指针 / 预览 quad;
  冒烟:载真场景,拿到 WebGPU、两块画面非空、控制台无 error。
没有 node / playwright-core / Chrome ⇒ 浏览器那几条 skip。只读:不写任何工程文件。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.workbench_rhi import browser  # noqa: E402
from tools.workbench_rhi.build import node_exe  # noqa: E402

_LAB = _ROOT / "tools" / "lightvolume_lab"
_PAGE = _LAB / "index.html"
_SELFTEST_JS = _LAB / "tests" / "selftest.js"
_REL = "tools/lightvolume_lab/index.html"


def _serve():
    return browser.serving([sys.executable, "-m", "tools.lightvolume_lab", "--port", "{port}", "--no-open"])


def test_page_has_no_webgl_or_glsl() -> None:
    src = _PAGE.read_text(encoding="utf-8")
    assert not re.search(r"getContext\(\s*['\"]webgl", src), "页面里还有 WebGL 上下文"
    for bad in ("#version 300 es", "gl_FragColor", "gl.createShader", "precision highp float", "uniform sampler2D"):
        assert bad not in src, f"页面里还有 GLSL:{bad}"
    assert "/gen/lightvol.bundle.js" in src and "createLightVolFx" in src and "createCanvasHost" in src
    # 剩下的 2D 上下文只许是:烘焙的辐射预滤波(数据管线)、图片解码、体积切片缩略图
    assert len(re.findall(r"getContext\(\s*'2d'", src)) == 3


def test_one_shader_source_owned_by_access_layer() -> None:
    wgsl = (_ROOT / "tools" / "workbench_rhi" / "lightvolFx.wgsl").read_text(encoding="utf-8")
    for fs in ("fsComp", "fsSim", "fsStamp", "fsPaint"):
        assert f"@fragment fn {fs}(" in wgsl
    ts = (_ROOT / "tools" / "workbench_rhi" / "lightvolFx.ts").read_text(encoding="utf-8")
    assert "lightvolFx.wgsl?raw" in ts and "#version" not in ts


@pytest.mark.skipif(not node_exe(), reason="没有 node")
def test_server_routes_and_bundle() -> None:
    with _serve() as base:
        boot = json.loads(urllib.request.urlopen(base + "/api/boot", timeout=300).read().decode("utf-8"))
        assert boot["ok"] and boot["bundle"]["ok"], boot
        r = urllib.request.urlopen(base + "/gen/lightvol.bundle.js", timeout=120)
        assert r.headers.get("Content-Type", "").startswith("text/javascript")
        js = r.read().decode("utf-8", "replace")
        assert "lightvolFx" in js and "workbenchRhi" in js
        page = urllib.request.urlopen(f"{base}/{_REL}", timeout=30).read().decode("utf-8")
        assert "LightVolume Lab" in page


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu() -> None:
    with _serve() as base:
        r = browser.run_page(f"{base}/{_REL}?base=/public", selftest=_SELFTEST_JS, no_skip=(_ROOT / "public" / "assets" / "scenes" / "test_room_b.json").is_file())
    sys.stdout.write(r.stdout[-8000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert "WebGPU 适配器:没有" not in r.stdout.replace("：", ":"), "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error(看上面的报告)"
    assert " 0 failed" in r.stdout
    for tag in ("PASS L1 ", "PASS L4 ", "PASS L5 ", "PASS L7 ", "PASS L8 ", "PASS L9 ", "PASS L11 ", "PASS L13 "):
        assert tag in r.stdout, f"缺 {tag.strip()}"


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
@pytest.mark.skipif(not (_ROOT / "public" / "assets" / "scenes" / "test_room_b.json").is_file(), reason="没有 test_room_b")
def test_page_smoke_in_chrome(tmp_path: Path) -> None:
    shot = tmp_path / "lightvolume_lab_smoke.png"
    with _serve() as base:
        r = browser.run_page(f"{base}/{_REL}?base=/public&scene=test_room_b", smoke=True, shot=shot)
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过(看上面)"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
