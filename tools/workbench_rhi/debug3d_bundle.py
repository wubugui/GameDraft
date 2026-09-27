# -*- coding: utf-8 -*-
"""工作台 RHI 接入层 · 3D 调试件的包：``tools/workbench_rhi/debug3d.ts``（+ ``debug3d.wgsl``）→ ``<工作台>/viewer/_gen/debug3d.bundle.js``。

四个工作台（粒子 / 地形 / 声学 / 轨迹）的 3D 视图都 ``import('/gen/debug3d.bundle.js')``，拿到命名空间 ``debug3d``
（``createView`` / ``Debug3DView`` …，见 README「3D 调试件」）。这份包与各台自己的运行时包分开打：3D 调试件只依赖 RHI，
各台的运行时包（sceneSpace / vfxSim / acousticSpace …）改动互不牵连，serve 只多一条路由。

  from tools.workbench_rhi import debug3d_bundle
  if u.path == debug3d_bundle.ROUTE:
      p, err = debug3d_bundle.ensure(GEN_DIR)

按需打、产物不进 git、判新旧靠打包器自报的源清单：全同 ``build.ensure``。
"""
from __future__ import annotations

from pathlib import Path

from tools.workbench_rhi import build

HERE = Path(__file__).resolve().parent
MODULE = HERE / "debug3d.ts"
SHADER = HERE / "debug3d.wgsl"
ROUTE = "/gen/debug3d.bundle.js"
OUT_NAME = "debug3d.bundle.js"
ENTRY_NAME = "debug3d_entry.ts"


def paths(gen_dir: Path) -> tuple[Path, Path]:
    """(入口, 产物)：放在调用方的 ``viewer/_gen/``（已 gitignore）。"""
    gen_dir = Path(gen_dir)
    return gen_dir / ENTRY_NAME, gen_dir / OUT_NAME


def ensure(gen_dir: Path, force: bool = False) -> tuple[Path | None, str]:
    """返回 (包路径, 错误说明)；最新就一个字节都不写。打不出来有旧包给旧包 + 原因。"""
    if not MODULE.is_file() or not SHADER.is_file():
        return None, f"3D 调试件源文件不存在：{MODULE} / {SHADER}"
    entry, out = paths(gen_dir)
    text = build.entry_source([MODULE], entry, "由 tools/workbench_rhi/debug3d_bundle.py 生成：工具 3D 调试视图的共用画法（RHI / WebGPU，着色器只有 debug3d.wgsl 一份）。")
    if build.write_if_changed(entry, text):
        force = True
    return build.ensure(entry, out, force=force)
