# -*- coding: utf-8 -*-
"""把运行时的呼吸图纯逻辑打成一个 ESM 包给工作台页面用(本地预览 = 同一份运行时代码,不是 JS 镜像)。

入口(命名空间名 = 文件名):

  * ``systems/breathing/BreathingPerformance.ts``  表演模拟本体(胸口 / 纸 / 垂帘 / 鼻息、渐弱、猛吸、参数渐变、纸比胸口晚)
  * ``systems/breathing/breathingParams.ts``       参数表(``src/data/breathingParams.json`` 的类型化与夹紧)
  * ``data/breathingOverlays.ts``                  资产解析(``resolveBreathingOverlay``,与游戏同一道闸门)
  * ``rendering/breathingUniforms.ts``             表演帧 → 着色器 uniform、切片 GLSL 的标记
  * ``audio/breathSynth.ts``                       呼吸声合成(游戏的 AudioManager 用的同一份)

着色器不进包:``serve`` 把 ``src/rendering/breathingShade.glsl`` 原样给页面,页面用包里的 ``sliceBreathingShade`` 切片
(与游戏的呼吸图 Mesh 同一份、同一对标记)。

缓存戳顺着值 import 扫整棵依赖树(``sources()``),不是手抄清单(只改被 import 的文件,页面也会重打)。
打包在子进程里做(pytest 装着仓库写守卫)。打不出来不致命:能改能存,只是没有本地预览。
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
    SRC / "systems" / "breathing" / "BreathingPerformance.ts",
    SRC / "systems" / "breathing" / "breathingParams.ts",
    SRC / "data" / "breathingOverlays.ts",
    SRC / "rendering" / "breathingUniforms.ts",
    SRC / "audio" / "breathSynth.ts",
]
SHADE_GLSL = SRC / "rendering" / "breathingShade.glsl"
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "breathing.bundle.js"
STAMP = GEN_DIR / "breathing.bundle.stamp.json"
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
    """入口顺着值 import 走出来的整棵依赖树(入口缺文件也列上,``ensure_bundle`` 据此报错)。"""
    seen: dict[Path, None] = {}
    todo = [p.resolve() for p in ENTRY_MODULES]
    while todo:
        p = todo.pop(0)
        if p in seen:
            continue
        seen[p] = None
        if p.suffix != ".ts":
            continue
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
    lines = ["// 由 tools/breathing_workbench/bundle.py 生成:呼吸图表演模拟 + 参数表 + 资产解析 + uniform 换算,同一份代码打给工作台页面。"]
    for p in ENTRY_MODULES:
        rel = os.path.relpath(p, GEN_DIR).replace(os.sep, "/")
        lines.append(f"export * as {p.stem} from '{rel}';")
    return "\n".join(lines) + "\n"


_BUILD_JS = r"""
// 由 tools/breathing_workbench/bundle.py 生成:把 _gen/entry.ts 打成 ESM。
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
        return (OUT if OUT.exists() else None), "找不到 node(PATH 与 .tools/node 都没有),无法打包运行时模块"
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
    """``breathingShade.glsl`` 原文(页面用包里的 ``sliceBreathingShade`` 切片,与游戏同一对标记)。"""
    return SHADE_GLSL.read_text(encoding="utf-8")


if __name__ == "__main__":
    p, err = ensure_bundle(force="--force" in sys.argv)
    print(p or "(none)", err or "ok")
    sys.exit(0 if p and not err else 1)
