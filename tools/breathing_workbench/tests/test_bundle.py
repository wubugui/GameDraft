# -*- coding: utf-8 -*-
"""运行时模块包:打得出来(子进程里打,pytest 装着仓库写守卫)、缓存戳是打包器自报的源清单、生成物不进版本;
页面没有第二份模拟 / 合成 / 着色组装——只许调包里的运行时代码;画面是**游戏同一份渲染**(engine2d / RHI + 呼吸图 Mesh 的 WGSL),
页面里没有任何自己的着色器,服务端也不再给 GLSL 孪生。"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.breathing_workbench import bundle  # noqa: E402
from tools.workbench_rhi import build as wbrhi  # noqa: E402

VIEWER = _ROOT / "tools" / "breathing_workbench" / "viewer"
_HAS_NODE = bundle.node_exe() is not None


@pytest.fixture(scope="module")
def built() -> Path:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = subprocess.run([sys.executable, "-m", "tools.breathing_workbench", "--bundle"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300, env=env)
    assert r.returncode == 0, f"打包失败:{r.stdout}\n{r.stderr[-2000:]}"
    assert bundle.OUT.is_file()
    return bundle.OUT


def test_sources_cover_the_whole_import_tree():
    srcs = {p.resolve().relative_to(_ROOT.resolve()).as_posix() for p in bundle.sources() if p.resolve().is_relative_to(_ROOT.resolve())}
    for m in ("src/systems/breathing/BreathingPerformance.ts", "src/systems/breathing/breathingParams.ts",
              "src/data/breathingParams.json", "src/data/breathingOverlays.ts", "src/rendering/breathingUniforms.ts",
              "src/audio/breathSynth.ts", "src/rendering/breathingOverlayMesh.ts", "src/rendering/overlayPercentLayout.ts",
              "tools/workbench_rhi/workbenchRhi.ts", "tools/workbench_rhi/offscreenReadback.ts",
              "tools/breathing_workbench/gpu/breathingView.ts"):
        assert m in srcs, m
    # 画面用游戏的呼吸图 Mesh,但不许把游戏组装层 / 状态 / 声音总线拖进页面包
    assert not any(s.endswith(("BreathingOverlaySystem.ts", "Game.ts", "AudioManager.ts", "CutsceneRenderer.ts")) for s in srcs), sorted(srcs)


def test_gen_is_gitignored():
    gi = (_ROOT / "tools" / "breathing_workbench" / ".gitignore").read_text(encoding="utf-8")
    assert "viewer/_gen/" in gi


def test_viewer_does_not_reimplement_runtime():
    js = "\n".join(p.read_text(encoding="utf-8") for p in VIEWER.glob("*.js"))
    for banned in ("class BreathingPerformance", "function softCap", "kickFor", "createBiquadFilter", "gaspShape",
                   "function breathingUniforms", "mergeBreathingParams = ", "vec3 breathingShade", "uniform sampler2D uBase",
                   "function percentLayerRect", "function createBreathingOverlayMesh", "function createBreathingFieldTextures"):
        assert banned not in js, banned
    for required in ("rt.BreathingPerformance.BreathingPerformance", "rt.breathSynth.createBreathSynth", "rt.breathingOverlays.resolveBreathingOverlay",
                     "rt.workbenchRhi.createCanvasHost(", "rt.breathingView.BreathingStage(", "rt.breathingView.REST_UNIFORMS",
                     "rt.offscreenReadback.createOffscreenTarget(", "rt.workbenchRhi.loadTexture(", "S.stage.applyFrame("):
        assert required in js, required


def test_viewer_has_no_shader_of_its_own():
    """页面里没有第二份着色器:不拿 GLSL、不开 WebGL、不写 WGSL、不同步读 GL 像素;服务端也不再给 GLSL 孪生。"""
    text = "\n".join(p.read_text(encoding="utf-8") for p in VIEWER.glob("*.js"))
    for forbidden in ("#version", "getContext('webgl", 'getContext("webgl', "gl_FragCoord", "gl_Position", "sampler2D",
                      "texelFetch(", "texture2D(", "breathingShade.glsl", "sliceBreathingShade", "__BREATHING_SHADE_BEGIN__",
                      "@fragment", "@vertex", "textureSample(", "createShader", "compileShader", "readPixels(", "texImage2D"):
        assert forbidden not in text, forbidden
    assert not hasattr(bundle, "shade_glsl") and not hasattr(bundle, "SHADE_GLSL")
    serve_src = (bundle.TOOL / "serve.py").read_text(encoding="utf-8")
    assert ".glsl" not in serve_src


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_bundle_exports_the_runtime_and_the_game_renderer(built: Path) -> None:
    text = built.read_text(encoding="utf-8")
    assert "var BreathingPerformance = class" in text and "createBreathSynth" in text
    for name in ("resolveBreathingOverlay", "breathingUniforms", "createBreathingOverlayMesh", "createBreathingFieldTextures",
                 "percentLayerRect", "BreathingStage", "createCanvasHost", "createRenderer", "WebGPURenderer",
                 "createOffscreenTarget", "OffscreenTarget", "RenderTexture"):
        assert re.search(rf"\b{name}\b", text), f"包里没有 {name}:画面就不是游戏那一份了"
    for ns in ("BreathingPerformance", "breathingParams", "breathingOverlays", "breathingUniforms", "breathSynth",
               "workbenchRhi", "offscreenReadback", "breathingView"):
        assert f"{ns}_exports as {ns}" in text, f"包里没导出 {ns}"
    # 呼吸图着色的 WGSL 原文就在包里(`breathingShade.wgsl?raw` 经 vite 打进来,与游戏同一份字节)
    wgsl = (_ROOT / "src" / "rendering" / "breathingShade.wgsl").read_text(encoding="utf-8")
    fns = re.findall(r"^fn (\w+)\(", wgsl, re.M)
    assert {"breathingShade", "bLayer", "bBodyDisp"} <= set(fns), fns
    for fn in fns:
        assert f"fn {fn}(" in text, f"包里没有 breathingShade.wgsl 的 {fn}"


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_stamp_lists_what_the_bundler_actually_read(built: Path) -> None:
    """判新旧的清单是打包器自己报的:WGSL(`?raw`)、游戏渲染模块、接入层、工作台胶水、依赖包都在里面。"""
    names = {p.name for p in wbrhi.inputs_of(bundle.OUT)}
    assert {"breathingShade.wgsl", "breathingOverlayMesh.ts", "overlayBlendShader.ts", "overlayPercentLayout.ts", "WebGPURenderer.ts",
            "LumaRhiDevice.ts", "workbenchRhi.ts", "offscreenReadback.ts", "breathingView.ts", "BreathingPerformance.ts",
            "package-lock.json"} <= names, sorted(names)


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_bundle_is_cached_by_source_stamp(built: Path) -> None:
    """没改源就一个字节都不写(本进程的仓库写守卫正好是硬判据:它要是重打就会被守卫拦下)。
    ⚠ 别的会话正在改被打包的 TS 时,两次调用之间源变了会重打——那种情况 skip,不算失败。"""
    before = built.stat().st_mtime_ns
    try:
        p, err = bundle.ensure_bundle()
    except PermissionError:
        if wbrhi.stale_reason(bundle.ENTRY, bundle.OUT):
            pytest.skip("被打包的运行时源在测试期间变了(别的会话在改)")
        raise
    assert p == built and not err
    assert p.stat().st_mtime_ns == before
    assert wbrhi.stale_reason(bundle.ENTRY, bundle.OUT) == ""
