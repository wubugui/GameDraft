# -*- coding: utf-8 -*-
"""把运行时的燃烧纯函数打成一个 ESM 包给工作台页面用（本地预览 = 同一份运行时代码，不是 JS 镜像）。

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
  * ``rendering/burn/burnImageData.ts``  读图的 RGBA（不预乘、长边 640，燃料网格与游戏逐位相同的前提）

着色器不进包：``serve`` 把 ``src/rendering/burn/burnShade.glsl`` 原样给页面，页面按同一对标记切片。

缓存戳顺着值 import 扫整棵依赖树（``sources()``），不是手抄清单（粒子台踩过：只改被 import 的文件，页面一直跑旧包）。
打包在子进程里做（pytest 装着仓库写守卫）。打不出来不致命：能改能存，只是没有本地预览与站位。
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
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
]
SHADE_GLSL = SRC / "rendering" / "burn" / "burnShade.glsl"
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "burn.bundle.js"
STAMP = GEN_DIR / "burn.bundle.stamp.json"
BUILD_SCRIPT = GEN_DIR / "build_bundle.cjs"
ENTRY = GEN_DIR / "entry.ts"

_IMPORT_RE = re.compile(r"""^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}/[^'"]+)['"]""", re.M)


def _resolve(base: Path, spec: str) -> Path | None:
    p = (base.parent / spec).resolve()
    for cand in (p, p.with_name(p.name + ".ts"), p / "index.ts"):
        if cand.is_file():
            return cand
    return None


def sources() -> list[Path]:
    """入口顺着值 import 走出来的整棵依赖树（入口缺文件也列上，``ensure_bundle`` 据此报错）。"""
    seen: dict[Path, None] = {}
    todo = [p.resolve() for p in ENTRY_MODULES]
    while todo:
        p = todo.pop(0)
        if p in seen:
            continue
        seen[p] = None
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            continue
        for spec in _IMPORT_RE.findall(text):
            dep = _resolve(p, spec)
            if dep is not None and dep not in seen:
                todo.append(dep)
    return list(seen)


def _entry_ts() -> str:
    lines = ["// 由 tools/burn_workbench/bundle.py 生成：燃烧纯函数 + 世界空间 + 站位，同一份代码打给工作台页面。"]
    for p in ENTRY_MODULES:
        rel = os.path.relpath(p, GEN_DIR).replace(os.sep, "/")
        lines.append(f"export * as {p.stem} from '{rel}';")
    return "\n".join(lines) + "\n"


_BUILD_JS = r"""
// 由 tools/burn_workbench/bundle.py 生成：把 _gen/entry.ts 打成 ESM。
const { build } = require('rolldown');
const [,, input, outFile] = process.argv;
build({
  input,
  platform: 'browser',
  output: { file: outFile, format: 'esm', sourcemap: false, minify: false },
  logLevel: 'silent',
}).then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });
"""


def node_exe() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for p in glob.glob(str(ROOT / ".tools" / "node" / "*" / "node.exe")):
        return p
    return None


def _stamp(srcs: list[Path], entry: str) -> dict:
    return {"srcs": [{"src": str(p), "mtime": p.stat().st_mtime, "size": p.stat().st_size} for p in srcs],
            "entry": entry}


def ensure_bundle(force: bool = False) -> tuple[Path | None, str]:
    """返回 (包路径, 错误说明)。包已是最新就一个字节都不写。"""
    srcs = sources()
    for p in srcs:
        if not p.exists():
            return None, f"运行时模块不存在: {p}"
    entry = _entry_ts()
    want = _stamp(srcs, entry)
    if not force and OUT.exists() and STAMP.exists():
        try:
            if json.loads(STAMP.read_text(encoding="utf-8")) == want:
                return OUT, ""
        except (OSError, ValueError):
            pass
    node = node_exe()
    if not node:
        return (OUT if OUT.exists() else None), "找不到 node（PATH 与 .tools/node 都没有），无法打包运行时模块"
    GEN_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_SCRIPT.write_text(_BUILD_JS, encoding="utf-8", newline="\n")
    ENTRY.write_text(entry, encoding="utf-8", newline="\n")
    try:
        proc = subprocess.run([node, str(BUILD_SCRIPT), str(ENTRY), str(OUT)], cwd=str(ROOT), capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=180,
                              env={**os.environ, "NODE_NO_WARNINGS": "1"})
    except (OSError, subprocess.TimeoutExpired) as e:
        return (OUT if OUT.exists() else None), f"rolldown 打包失败: {e}"
    if proc.returncode != 0 or not OUT.exists():
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
        return (OUT if OUT.exists() else None), "rolldown 打包失败:\n" + "\n".join(tail)
    STAMP.write_text(json.dumps(want), encoding="utf-8", newline="\n")
    return OUT, ""


def shade_glsl() -> str:
    """``burnShade.glsl`` 原文（页面按 ``//__BURN_SHADE_BEGIN__`` / ``//__BURN_SHADE_END__`` 切片，与 BurnFilters 同一对标记）。"""
    return SHADE_GLSL.read_text(encoding="utf-8")


if __name__ == "__main__":
    p, err = ensure_bundle(force="--force" in sys.argv)
    print(p or "(none)", err or "ok")
    sys.exit(0 if p and not err else 1)
