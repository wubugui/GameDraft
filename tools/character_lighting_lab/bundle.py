# -*- coding: utf-8 -*-
"""把角色照明实验室查看器要的**游戏同一份**渲染打成一个 ESM 包给页面用（`viewer/_gen/charlab.bundle.js`）。

查看器迁到 RHI（2026-09-28）之后页面里不再有 WebGL / GLSL：2D 场景视图的角色受光是游戏的
`CharacterLightingSystem` + `CharacterLitSprite`（WGSL）+ `SceneDepthSystem` / `DepthOcclusionFilter` 拼出来的，
3D 检视走接入层的 3D 调试件，纯工具视图的逐像素图在 CPU 上算。打包走共用的工作台 RHI 接入层
（``tools/workbench_rhi``：vite 库模式、打包器自报的源清单判新旧、产物不进 git）。

入口（命名空间名 = 文件名）：

  * ``tools/workbench_rhi/workbenchRhi.ts``       画布宿主：在 2D 画布上建游戏同一个 WebGPU 渲染器、装图、回读
  * ``tools/workbench_rhi/offscreenReadback.ts``  离屏渲染纹理 + 异步回读（3D 视图里角色 quad 的贴图就是这样出的）
  * ``tools/workbench_rhi/debug3d.ts``            3D 检视（场景网格 / 点云 / probe 点 / 射线 / 全景球 / 角色 quad）；
                                                  与 2D 渲染器打在**同一个包**里：一页只许有一份 luma / RHI
  * ``tools/character_lighting_lab/gpu/charLabView.ts``  2D 场景视图：游戏的角色受光与深度遮挡拼出来
  * ``tools/character_lighting_lab/gpu/labImages.ts``    纯工具视图的逐像素图（背景 HDR / 增益 / 分层 / 深度、三张缩略图、3D 几何）

打包在子进程里做。打不出来不致命：烘焙 / 导出 / 编辑照常，只是没有画面（页面会说原因）。
"""
from __future__ import annotations

import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.workbench_rhi import build as wbrhi  # noqa: E402

ENTRY_MODULES = [
    ROOT / "tools" / "workbench_rhi" / "workbenchRhi.ts",
    ROOT / "tools" / "workbench_rhi" / "offscreenReadback.ts",
    ROOT / "tools" / "workbench_rhi" / "debug3d.ts",
    TOOL / "gpu" / "charLabView.ts",
    TOOL / "gpu" / "labImages.ts",
]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "charlab.bundle.js"
STAMP = wbrhi.stamp_path(OUT)
ENTRY = GEN_DIR / "entry.ts"
ROUTE = "/gen/charlab.bundle.js"


def sources() -> list[Path]:
    """入口顺着值 import 走出来的仓库内源文件（打之前的近似；权威清单是打包戳 ``wbrhi.inputs_of(OUT)``）。"""
    return wbrhi.import_tree(ENTRY_MODULES)


def _entry_ts() -> str:
    return wbrhi.entry_source(ENTRY_MODULES, ENTRY,
                              "由 tools/character_lighting_lab/bundle.py 生成：游戏的角色受光 / 深度遮挡 + 3D 调试件 + 工具视图，打给实验室查看器。")


def ensure_bundle(force: bool = False) -> tuple[Path | None, str]:
    """返回 (包路径, 错误说明)。包已是最新就一个字节都不写。"""
    for p in ENTRY_MODULES:
        if not p.exists():
            return None, f"模块不存在: {p}"
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
