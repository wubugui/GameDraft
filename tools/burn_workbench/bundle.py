# -*- coding: utf-8 -*-
"""把运行时的燃烧纯函数 + engine2d / RHI 与共享燃烧 WGSL 单 pass 预览打成一个 ESM 包给工作台页面用
（本地预览 = 同一份运行时代码，不是 JS 镜像；画面 = 游戏同一套 WGSL，不是 GLSL 孪生）。

打包走共用的工作台 RHI 接入层（``tools/workbench_rhi``：vite 库模式、打包器自报的源清单判新旧、产物不进 git）。

入口（命名空间名 = 文件名）：

  * ``systems/burn/burnSim.ts``          燃料网格 / 场景模拟（世界映射表 ``worlds``）/ 事件 / 燃烧场纹理编码 / 读数
  * ``systems/burn/burnGeometry.ts``     实例摆放（``burnEntityPlacement`` → ``burnPlacementFrame``）↔ 图 uv ↔ 场景坐标、9×9 世界映射
  * ``systems/burn/burnAim.ts``          点火时火头伸到哪（着火点 / 燃料中间）
  * ``systems/burn/igniteStance.ts``     接触帧 / 火头偏移 / 左右两个站位 / 站位求解器（不牵游戏状态机）
  * ``data/burnables.ts``                ``resolveBurnable`` / ``burnableWorldSize``（模板真实尺寸 → wu）与缺省
  * ``data/animationSockets.ts``         挂点解析与失效判定
  * ``data/propPresets.ts``              挂件预设解析、状态合并
  * ``data/resolveAnimationSet.ts``      anim.json 的世界尺寸推导
  * ``utils/sceneSpace.ts`` / ``systems/vfx/vfxSpace.ts`` / ``utils/depthShellField.ts``   世界空间（与粒子系统同一份）
  * ``utils/sceneWind.ts`` / ``utils/perspectiveScale.ts`` / ``utils/entityTransform.ts``   风、透视系数、实例缩放旋转锚点
  * ``rendering/lighting/kelvin.ts``     色温 → 线性 RGB（火线 / 余烬发光色）
  * ``rendering/burn/burnShadeParams.ts`` 着色参数（与 ``BurnSystem`` 同一个函数）
  * ``rendering/burn/burnImageData.ts``  读图的 RGBA（不预乘、长边 640，燃料网格与游戏逐位相同的前提）
  * ``tools/workbench_rhi/workbenchRhi.ts``  画布宿主：在页面画布上建游戏同一个 WebGPU 渲染器、装图、回读
  * ``tools/burn_workbench/gpu/burnView.ts`` 画面：旧工具单 pass 组合（共享 burnShade.wgsl，直通采样后预乘）

燃烧数学没有工具自己的一份：页面不再拿任何 GLSL（旧的 ``/gen/burnShade.glsl`` 已删）。
打包在子进程里做（pytest 装着仓库写守卫）。打不出来不致命：能改能存，只是没有本地预览与站位。
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
ENTRY_MODULES = [
    SRC / "systems" / "burn" / "burnSim.ts",
    SRC / "systems" / "burn" / "burnGeometry.ts",
    SRC / "systems" / "burn" / "burnAim.ts",
    SRC / "systems" / "burn" / "igniteStance.ts",
    SRC / "data" / "burnables.ts",
    SRC / "data" / "animationSockets.ts",
    SRC / "data" / "propPresets.ts",
    SRC / "data" / "resolveAnimationSet.ts",
    SRC / "utils" / "sceneSpace.ts",
    SRC / "systems" / "vfx" / "vfxSpace.ts",
    SRC / "utils" / "depthShellField.ts",
    SRC / "utils" / "sceneWind.ts",
    SRC / "utils" / "perspectiveScale.ts",
    SRC / "utils" / "entityTransform.ts",
    SRC / "rendering" / "lighting" / "kelvin.ts",
    SRC / "rendering" / "burn" / "burnShadeParams.ts",
    SRC / "rendering" / "burn" / "burnImageData.ts",
    ROOT / "tools" / "workbench_rhi" / "workbenchRhi.ts",
    TOOL / "gpu" / "burnView.ts",
]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "burn.bundle.js"
STAMP = wbrhi.stamp_path(OUT)
ENTRY = GEN_DIR / "entry.ts"


def sources() -> list[Path]:
    """入口顺着值 import 走出来的仓库内源文件（打之前的近似；权威清单是打包戳 ``wbrhi.inputs_of(OUT)``）。"""
    return wbrhi.import_tree(ENTRY_MODULES)


def _entry_ts() -> str:
    return wbrhi.entry_source(ENTRY_MODULES, ENTRY,
                              "由 tools/burn_workbench/bundle.py 生成：燃烧纯函数 + 世界空间 + 站位 + 游戏同一份渲染，打给工作台页面。")


def node_exe() -> str | None:
    return wbrhi.node_exe()


def ensure_bundle(force: bool = False) -> tuple[Path | None, str]:
    """返回 (包路径, 错误说明)。包已是最新就一个字节都不写。"""
    for p in ENTRY_MODULES:
        if not p.exists():
            return None, f"运行时模块不存在: {p}"
    # 入口在打包锁里写、写完再核戳（几个进程同时撞上过期时只打一次，见 tools/workbench_rhi/build.py）
    return wbrhi.ensure_entry(ENTRY, _entry_ts(), OUT, force=force)


if __name__ == "__main__":
    p, err = ensure_bundle(force="--force" in sys.argv)
    print(p or "(none)", err or "ok")
    sys.exit(0 if p and not err else 1)
