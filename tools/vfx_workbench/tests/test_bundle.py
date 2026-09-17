# -*- coding: utf-8 -*-
"""本地预览的裁判：`/gen/vfx.bundle.js` 必须真的是**运行时那几个模块本体**打出来的。

这道门管的是"两份实现必然漂"这条：页面里 `new VfxInstanceSim(...)` 跑的就是 `src/systems/vfx/vfxSim.ts`，
不是照着写的第二份。所以断言的是包里确实导出了那几个命名空间与关键符号，而不只是"文件存在"。

⚠ 打包要往 `viewer/_gen/`（工作树内、已 gitignore）写，而 pytest 进程里装着仓库写守卫
（`tools/testing/repo_write_guard.py`）。所以**打包走子进程**（`python -m tools.vfx_workbench --bundle`，
与工作台自己开页时那条是同一个函数），本进程只读产物、只做"已是最新就不动"的缓存断言。
没有 node（PATH 与 .tools/node 都没有）就 skip——那台机器上工作台照样能改参数、能存盘。
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

from tools.vfx_workbench import bundle  # noqa: E402

_HAS_NODE = bundle.node_exe() is not None


@pytest.fixture(scope="module")
def built() -> Path:
    """子进程里打一次包（本进程有仓库写守卫，不能自己写 viewer/_gen/）。"""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = subprocess.run([sys.executable, "-m", "tools.vfx_workbench", "--bundle"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300, env=env)
    assert r.returncode == 0, f"打包失败：{r.stdout}\n{r.stderr[-2000:]}"
    assert bundle.OUT.is_file()
    return bundle.OUT


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node（PATH 与 .tools/node 都没有）")
def test_bundle_exports_the_runtime_modules(built: Path) -> None:
    src = built.read_text(encoding="utf-8")
    for name in ("VfxInstanceSim", "createFieldRuntime", "createFieldVfxSpace", "groundWorldAt",
                 "buildDepthShellField", "shellContactAt", "buildGroundHeightfield", "viewDirWorld", "worldToScene",
                 "SceneWindState", "resolveSceneWind", "createPerspectiveScaleResolver", "stepPlates",
                 # 布置：没写 seed 时按 id 派生的哈希（与 VfxSystem.ensureSim 同一个）、画范围区域边带内沿的距离等值线
                 "hashSeed", "buildConfineField", "confineDistanceContour",
                 # 薄片可燃（燃烧系统）：外部给点 setSpawnPoints、碰火推进 stepPlateBurn、页面画焦黑 / 缺省对账用的两个函数
                 "setSpawnPoints", "stepPlateBurn", "plateBurnProgress", "resolvePlateBurnParams",
                 # 薄片绑的可燃物模板：页面把 /api/burnables 的原始文档过它装成 burnTemplates（与 VfxSystem 同一个清洗函数）
                 "resolveBurnable", "BURN_DEFAULTS",
                 # 光柱：帧与形状闸门、原画视图预览层编译的那一份 GLSL 核心与 uniform 打包
                 "resolveBeam3dFrame", "resolveBeam2dFrame", "beamDefErrors", "sceneQAffine", "packBeamUniforms",
                 "BEAM_GLSL_CORE", "BEAM_GLSL_UNIFORMS"):
        assert re.search(rf"\b{name}\b", src), f"包里没有 {name}：本地预览就不是运行时那一份了"
    for ns in ("vfxSim", "vfxSpace", "sceneSpace", "depthShellField", "groundHeightfield", "sceneWind", "perspectiveScale",
               "vfxRandom", "vfxConfine", "vfxProgram", "vfxMotionSource", "vfxPlateBurn", "burnables", "vfxBeam", "vfxBeamGlsl"):
        assert f"{ns}_exports" in src or f"as {ns}" in src, f"包里没导出 {ns}"
    assert "VFX_SUBSTEP" in src, "定步长常量丢了 = 打的不是模拟核心"


@pytest.mark.skipif(not _HAS_NODE, reason="没有 node")
def test_bundle_is_cached_by_source_stamp(built: Path) -> None:
    """按源文件 mtime + 大小做戳：没改源就一个字节都不写（开页不该每次等 rolldown，
    本进程的仓库写守卫也正好是这条的硬判据——它要是重打就会被守卫拦下）。"""
    before = built.stat().st_mtime_ns
    p, err = bundle.ensure_bundle()
    assert p == built and not err
    assert p.stat().st_mtime_ns == before


def test_sources_cover_the_whole_import_tree() -> None:
    """戳要盖住入口的整棵依赖树——少一个文件，改了它包也不重打，页面里的"运行时"就是旧的。
    手抄清单漏过 vfxPlate.ts / sceneWind.ts（2026-09-12），所以现在是顺着 import 现场扫。"""
    srcs = bundle.sources()
    missing = [str(s) for s in srcs if not s.exists()]
    assert not missing, missing
    names = {s.name for s in srcs}
    assert {"vfxSim.ts", "vfxSpace.ts", "vfxPlate.ts", "vfxNoise.ts", "vfxRandom.ts", "sceneSpace.ts",
            "depthShellField.ts", "groundHeightfield.ts", "worldReconstruct.ts", "groundDepthField.ts",
            "sceneWind.ts", "perspectiveScale.ts", "vfxConfine.ts", "vfxProgram.ts", "vfxMotionSource.ts", "vfxSimulationContract.json",
            # vfxSim 多行 import 进来的可燃薄片与它的色温换算：只改它俩页面也得重打包
            "vfxPlateBurn.ts", "kelvin.ts",
            # 可燃物模板清洗（页面命名空间 burnables）：只改它，页面里模板的缺省也得跟着重打
            "burnables.ts",
            # 光柱：几何 / 着色核心 / 契约 / 共用曲线采样
            "vfxBeam.ts", "vfxBeamGlsl.ts", "vfxBeamContract.json", "vfxCurve.ts"} <= names, names
    # 只有类型的 import 打包时整条擦掉：types.ts 天天在改，进了戳就每次开页都白等 rolldown
    assert "types.ts" not in names


def test_import_scan_follows_value_imports_only(tmp_path: Path) -> None:
    (tmp_path / "a.ts").write_text(
        "import type { T } from './t';\n"
        "import {\n  x,\n  type Y,\n} from './b';\n"
        "export * as c from './c.ts';\n"
        "export type { Z } from './z';\n", encoding="utf-8")
    for n in ("b", "c", "t", "z"):
        (tmp_path / f"{n}.ts").write_text("export const v = 1;\n", encoding="utf-8")
    old = bundle.ENTRY_MODULES
    try:
        bundle.ENTRY_MODULES = [tmp_path / "a.ts"]
        names = {p.name for p in bundle.sources()}
    finally:
        bundle.ENTRY_MODULES = old
    assert names == {"a.ts", "b.ts", "c.ts"}, names


def test_gen_dir_is_gitignored() -> None:
    """产物不入库（`viewer/_gen/`）：包是派生物，跟着源走。"""
    ign = (bundle.TOOL / ".gitignore").read_text(encoding="utf-8")
    assert "viewer/_gen/" in ign
