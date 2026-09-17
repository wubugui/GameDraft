# -*- coding: utf-8 -*-
"""本地预览的裁判：`/gen/burn.bundle.js` 必须真的是**运行时那几个模块本体**打出来的（不是 JS 里照着写的第二份）。

打包在子进程里做（pytest 进程装着仓库写守卫，不能自己写 `viewer/_gen/`）；本进程只读产物。
没有 node（PATH 与 .tools/node 都没有）就 skip——那台机器上工作台照样能改能存，只是没有本地预览。
"""
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

from tools.burn_workbench import bundle  # noqa: E402

_HAS_NODE = bundle.node_exe() is not None


@pytest.fixture(scope="module")
def built() -> Path:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = subprocess.run([sys.executable, "-m", "tools.burn_workbench", "--bundle"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300, env=env)
    assert r.returncode == 0, f"打包失败：{r.stdout}\n{r.stderr[-2000:]}"
    assert bundle.OUT.is_file()
    return bundle.OUT


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_bundle_exports_the_runtime_modules(built: Path) -> None:
    src = built.read_text(encoding="utf-8")
    for name in ("BurnSceneSim", "buildBurnGrid", "encodeTexture", "burnUvToScene", "burnSceneToUv", "buildBurnWorldGrid",
                 "burnEntityPlacement", "burnPlacementFrame", "burnFrameExtent",
                 "burnIgniteAim", "burnFuelCenterUv", "igniteStancesFor", "igniteContactOf", "igniteTipOffset", "solveIgniteStance",
                 "resolveBurnable", "burnableWorldSize", "BURN_DEFAULTS", "BURN_WU_PER_M", "resolveSockets", "attachmentPointLocal",
                 "parsePropPresets", "resolvePropAttach",
                 "normalizeAnimationSetDef", "createFieldVfxSpace", "createPlanarVfxSpace", "groundWorldAt", "viewDirWorld",
                 "buildDepthShellField", "resolveSceneWind", "sampleSceneWind", "createPerspectiveScaleResolver", "perspectiveScaleAt",
                 "entityScaleOf", "kelvinToLinearRgb", "loadBurnImageData"):
        assert re.search(rf"\b{name}\b", src), f"包里没有 {name}：本地预览就不是运行时那一份了"
    for ns in ("burnSim", "burnGeometry", "burnAim", "igniteStance", "burnables", "animationSockets", "propPresets",
               "resolveAnimationSet", "sceneSpace", "vfxSpace", "depthShellField", "sceneWind", "perspectiveScale",
               "entityTransform", "kelvin", "burnImageData"):
        assert f"{ns}_exports as {ns}" in src, f"包里没导出 {ns}"


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_bundle_is_cached_by_source_stamp(built: Path) -> None:
    """没改源就一个字节都不写（本进程的仓库写守卫正好是硬判据：它要是重打就会被守卫拦下）。
    ⚠ 别的会话正在改被打包的 TS 时，两次调用之间源变了会重打——那种情况 skip，不算失败。"""
    before = built.stat().st_mtime_ns
    stamp_before = bundle._stamp(bundle.sources(), bundle._entry_ts())
    try:
        p, err = bundle.ensure_bundle()
    except PermissionError:
        if bundle._stamp(bundle.sources(), bundle._entry_ts()) != stamp_before:
            pytest.skip("被打包的运行时源在测试期间变了（别的会话在改）")
        raise
    assert p == built and not err
    assert p.stat().st_mtime_ns == before


def test_sources_cover_the_whole_import_tree() -> None:
    srcs = bundle.sources()
    missing = [str(s) for s in srcs if not s.exists()]
    assert not missing, missing
    names = {s.name for s in srcs}
    assert {"burnSim.ts", "burnGeometry.ts", "burnAim.ts", "igniteStance.ts", "burnShadeParams.ts", "burnables.ts",
            "animationSockets.ts", "propPresets.ts", "resolveAnimationSet.ts", "sceneSpace.ts", "vfxSpace.ts",
            "depthShellField.ts", "groundHeightfield.ts", "groundDepthField.ts", "worldReconstruct.ts", "sceneWind.ts",
            "perspectiveScale.ts", "entityTransform.ts", "kelvin.ts", "burnImageData.ts", "assetPath.ts"} <= names, names
    # 站位求解器住在 igniteStance.ts：包不牵点火表演 / 游戏状态机（types.ts 一改包就重打）
    assert "ignitePerformer.ts" not in names and "types.ts" not in names, names


def test_shade_glsl_is_the_runtime_single_source() -> None:
    txt = bundle.shade_glsl()
    assert bundle.SHADE_GLSL == _ROOT / "src" / "rendering" / "burn" / "burnShade.glsl"
    assert "//__BURN_SHADE_BEGIN__" in txt and "//__BURN_SHADE_END__" in txt and "vec4 burnSample(" in txt
    # 游戏滤镜切的是同一对标记
    filters = (_ROOT / "src" / "rendering" / "burn" / "BurnFilters.ts").read_text(encoding="utf-8")
    assert "sliceGlsl(BURN_SHADE_SRC, 'BURN_SHADE')" in filters
    page = (bundle.TOOL / "viewer" / "preview.js").read_text(encoding="utf-8")
    assert "'//__BURN_SHADE_BEGIN__'" in page and "'//__BURN_SHADE_END__'" in page


def test_viewer_does_not_reimplement_the_sim() -> None:
    """页面里不许出现模拟 / 摆放 / 站位 / 映射 / 着色组装的第二份实现：这些名字只能作为包里的调用出现。"""
    viewer = bundle.TOOL / "viewer"
    text = "\n".join(p.read_text(encoding="utf-8") for p in viewer.glob("*.js"))
    for forbidden in ("class BurnSceneSim", "function buildBurnGrid", "function burnUvToScene", "function burnSceneToUv",
                      "function burnEntityPlacement", "function burnPlacementFrame", "function burnFrameExtent",
                      "function buildBurnWorldGrid", "function burnableWorldSize", "function resolveBurnable",
                      "function solveIgniteStance", "function igniteStancesFor", "function socketPoseToLocal",
                      "function sampleSceneWind", "function burnShadeParamsOf", "float burnHash",
                      "kelvinToLinearRgb(", "uBurnCharColor * (0.6",
                      # 旧模型（场景 → 热点 → 布置）的残留：页面里一个都不许有
                      "burnHotspotFrameOf", "burn_placements", "/api/library", "scenePlacements"):
        assert forbidden not in text, forbidden
    for used in ("rt.burnSim.buildBurnGrid", "rt.burnGeometry.buildBurnWorldGrid", "rt.igniteStance.igniteStancesFor",
                 "rt.burnables.resolveBurnable", "rt.burnables.burnableWorldSize", "S.rt.burnSim.BurnSceneSim", "loadBurnImageData",
                 "g.burnEntityPlacement(", "g.burnPlacementFrame(", "burnGeometry.burnFrameExtent(",
                 "burnShadeParams.burnShadeParamsOf", "burnMaterial(", "burnGlowAdd("):
        assert used in text, used


def test_gen_dir_is_gitignored() -> None:
    ign = (bundle.TOOL / ".gitignore").read_text(encoding="utf-8")
    assert "viewer/_gen/" in ign
