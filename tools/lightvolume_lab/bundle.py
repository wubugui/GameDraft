# -*- coding: utf-8 -*-
"""把光照体实验室页面要的 RHI 画法打成一个 ESM 包(``_gen/lightvol.bundle.js``,页面经 ``/gen/lightvol.bundle.js`` 拿)。

页面迁到 RHI(2026-09-28)之后不再有 WebGL / GLSL:

  * ``tools/workbench_rhi/workbenchRhi.ts``  预览画布(背景 + 两个 quad + 标签 + 脚点):游戏同一个 WebGPU 渲染器(engine2d)
  * ``tools/workbench_rhi/lightvolFx.ts``    环境 FX(雾 / 体积光 / 积水 / 积雪 / 脚印):接入层自有的一份 WGSL(游戏里没有对应效果)

两个入口打在**同一个包**里:一页只许有一份 luma / RHI。打包走共用的接入层(vite 库模式、打包器自报源清单判新旧、产物不进 git)。
打不出来不致命:载入 / 烘焙 / 导出 / 切片照常,画面区写原因。
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
    ROOT / "tools" / "workbench_rhi" / "lightvolFx.ts",
]
GEN_DIR = TOOL / "_gen"
OUT = GEN_DIR / "lightvol.bundle.js"
ENTRY = GEN_DIR / "entry.ts"
ROUTE = "/gen/lightvol.bundle.js"


def _entry_ts() -> str:
    return wbrhi.entry_source(ENTRY_MODULES, ENTRY, "由 tools/lightvolume_lab/bundle.py 生成:预览画布宿主 + 环境 FX,打给光照体实验室页面。")


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
