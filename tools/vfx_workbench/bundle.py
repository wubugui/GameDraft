# -*- coding: utf-8 -*-
"""把运行时的粒子模拟核心 + 游戏同一份粒子渲染打成一个 ESM 包给工作台页面用
（本地预览 = 同一份运行时模拟；原画视图的画面 = 游戏同一个 `VfxRenderer` 与 WGSL，不是 GLSL 孪生、不是画点）。

为什么不在 JS 里再写一份积分器 / 着色：工作台是**唯一**写 ``public/assets/data/vfx/`` 的地方，作者在这里
看到的那一群蝙蝠，就是游戏开播时要飞的那一群。两边各写一份必然漂移，而且**漂了一处都不报错**
（2026-09-08 声学工作台镜像、2026-09-10 轨迹工作台镜像，两次都是这个形状）。所以这里不镜像任何
数学，只把那几个 TS 模块打成浏览器能 import 的 ESM。

打包走共用的工作台 RHI 接入层（``tools/workbench_rhi``：vite 库模式、打包器自报的源清单判新旧、产物不进 git）——
游戏的渲染模块里有 ``*.wgsl?raw``、``import.meta.env``，裸 rolldown 打不了。

入口（命名空间名 = 文件名）：

  * ``systems/vfx/vfxSim.ts``        —— 模拟核心（纯函数、定步长 1/120、确定性）
  * ``systems/vfx/vfxSpace.ts``     —— 模拟看到的"世界"（地面 / 壳 / 画面换算）
  * ``utils/sceneSpace.ts``         —— 画面点 ↔ M-world 的**唯一实现**（坐标对齐自证的裁判）
  * ``utils/depthShellField.ts``    —— CPU 侧深度壳（壳接触，与 geometry.py 的 shell_contact 同式）
  * ``utils/groundHeightfield.ts``  —— 世界 XZ 地面高度场
  * ``utils/sceneWind.ts``          —— 场景风（与游戏同一份参数解析 + 同一个钟）
  * ``utils/perspectiveScale.ts``   —— 场景透视系数（薄片的尺寸 / 位移按它折）
  * ``systems/vfx/vfxRandom.ts``    —— ``hashSeed``：布置没写 seed 时按实例 id 派生（与 ``VfxSystem.ensureSim`` 同一个函数）
  * ``systems/vfx/vfxConfine.ts``   —— 粒子区域的权重网格与 ``confineDistanceContour``（画范围区域的边带内沿；
                                      别在 JS 里另写一份距离场，F2 叠加层与本台画的是同一条线）
  * ``systems/vfx/vfxProgram.ts`` / ``vfxMotionSource.ts`` —— 发射器程序解析、玩家动静 / 接触源
  * ``systems/vfx/vfxPlateBurn.ts`` —— 薄片可燃（受热 / 着 / 成灰；燃烧工作台打包的是同一份）
  * ``data/burnables.ts``           —— 可燃物模板清洗 ``resolveBurnable``（薄片绑的模板经它装进 ``burnTemplates``，
                                      与 ``VfxSystem`` 同一个函数；页面不另写清洗 / 缺省）
  * ``systems/vfx/vfxBeam.ts``      —— 光柱帧 / 局部坐标 / 形状闸门 / 画面↔世界仿射（3D 视图画线框、把手用）
  * ``systems/vfx/vfxBolt.ts``      —— 雷形（现画的雷）
  * ``tools/workbench_rhi/workbenchRhi.ts``  —— 画布宿主：在页面画布上建游戏同一个 WebGPU 渲染器、装图、回读
  * ``tools/vfx_workbench/gpu/vfxView.ts``   —— 画面：游戏的 ``VfxRenderer``（粒子 / 薄片 / 雷 / 光柱）+ 贴图表装载
                                              （``loadVfxSpriteSheet``，与 ``VfxSystem`` 同一个函数）拼出来

着色器没有工具自己的一份：页面不再拿任何 GLSL（旧的 ``vfxBeamGlsl`` / ``vfxBoltGlsl`` 命名空间已从入口拿掉）。
打包在子进程里做（pytest 装着仓库写守卫）。打不出来不致命：工作台照样能改参数、能存盘，只是**页面不能本地预览、
也做不了坐标自证**（场景芯片会说明）——那时候只能靠联动去游戏里看。
"""
from __future__ import annotations

import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.workbench_rhi import build as wbrhi  # noqa: E402

SRC = ROOT / "src"
#: 页面 import 的模块（命名空间名 = 文件名）。入口从这一张表派生；新旧由打包戳（打包器自报的源清单）判。
ENTRY_MODULES = [
    SRC / "systems" / "vfx" / "vfxSim.ts",
    SRC / "systems" / "vfx" / "vfxSpace.ts",
    SRC / "utils" / "sceneSpace.ts",
    SRC / "utils" / "depthShellField.ts",
    SRC / "utils" / "groundHeightfield.ts",
    SRC / "utils" / "sceneWind.ts",
    SRC / "utils" / "perspectiveScale.ts",
    SRC / "systems" / "vfx" / "vfxRandom.ts",
    SRC / "systems" / "vfx" / "vfxConfine.ts",
    SRC / "systems" / "vfx" / "vfxProgram.ts",
    SRC / "systems" / "vfx" / "vfxMotionSource.ts",
    # 薄片可燃（vfxSim 本来就 import 它；单列出来是给页面一个命名空间：燃烧状态读数、自检拿 resolvePlateBurnParams 对账模板参数）
    SRC / "systems" / "vfx" / "vfxPlateBurn.ts",
    # 可燃物模板清洗（页面命名空间 burnables）：/api/burnables 的原始文档过 resolveBurnable(doc, id) 装成 burnTemplates，
    # 与游戏 VfxSystem.loadBurnTemplate 同一个函数——页面里不许另写清洗 / 缺省
    SRC / "data" / "burnables.ts",
    # 光柱（体积光）：帧 / 局部坐标 / 形状闸门 / 画面↔世界仿射（vfxSim 本来就 import 它，单列给页面命名空间：3D 线框、把手）
    SRC / "systems" / "vfx" / "vfxBeam.ts",
    # 雷（现画）：形状
    SRC / "systems" / "vfx" / "vfxBolt.ts",
    # 画布宿主（游戏同一个 WebGPU 渲染器）+ 原画视图 / 雷预览的画面（游戏的 VfxRenderer 拼）
    ROOT / "tools" / "workbench_rhi" / "workbenchRhi.ts",
    TOOL / "gpu" / "vfxView.ts",
    # 3D 视图的 3D 调试件也打在这一个包里：一页只许有一份 luma / RHI（分成 vfx / debug3d 两个包各带一份的话，
    # 第二份初始化时 luma 报「This version of luma.gl has already been initialized」）；/gen/debug3d.bundle.js 转出它
    ROOT / "tools" / "workbench_rhi" / "debug3d.ts",
]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "vfx.bundle.js"
STAMP = wbrhi.stamp_path(OUT)
ENTRY = GEN_DIR / "entry.ts"


def sources() -> list[Path]:
    """入口顺着值 import 走出来的仓库内源文件（打之前的近似；权威清单是打包戳 ``wbrhi.inputs_of(OUT)``）。"""
    return wbrhi.import_tree(ENTRY_MODULES)


def _entry_ts() -> str:
    return wbrhi.entry_source(ENTRY_MODULES, ENTRY,
                              "由 tools/vfx_workbench/bundle.py 生成：粒子模拟核心 + 画面↔M-world 换算 + 游戏同一份粒子渲染，打给工作台页面。")


def node_exe() -> str | None:
    return wbrhi.node_exe()


def ensure_bundle(force: bool = False) -> tuple[Path | None, str]:
    """返回 (包路径, 错误说明)。包已是最新就一个字节都不写。"""
    for p in ENTRY_MODULES:
        if not p.exists():
            return None, f"运行时模块不存在: {p}"
    entry = _entry_ts()
    try:
        if ENTRY.read_text(encoding="utf-8") != entry:
            force = True
    except OSError:
        force = True
    if not force and not wbrhi.stale_reason(ENTRY, OUT):
        return OUT, ""
    wbrhi.write_if_changed(ENTRY, entry)
    return wbrhi.ensure(ENTRY, OUT, force=force)


if __name__ == "__main__":
    p, err = ensure_bundle(force="--force" in sys.argv)
    print(p or "(none)", err or "ok")
    sys.exit(0 if p and not err else 1)
