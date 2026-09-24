# -*- coding: utf-8 -*-
"""把运行时的粒子模拟核心打成一个 ESM 包给工作台页面用（本地预览 = 同一份运行时模拟）。

为什么不在 JS 里再写一份积分器：工作台是**唯一**写 ``public/assets/data/vfx/`` 的地方，作者在这里
看到的那一群蝙蝠，就是游戏开播时要飞的那一群。两边各写一份必然漂移，而且**漂了一处都不报错**
（2026-09-08 声学工作台镜像、2026-09-10 轨迹工作台镜像，两次都是这个形状）。所以这里不镜像任何
数学，只把那几个 TS 模块用仓库自带的 rolldown（vite 8 的打包器）打成浏览器能 import 的 ESM：

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
  * ``systems/vfx/vfxPlateBurn.ts`` —— 薄片可燃（受热 / 着 / 成灰；燃烧工作台打包的是同一份）
  * ``data/burnables.ts``           —— 可燃物模板清洗 ``resolveBurnable``（薄片绑的模板经它装进 ``burnTemplates``，
                                      与 ``VfxSystem`` 同一个函数；页面不另写清洗 / 缺省）

缓存：按 TS 源文件 mtime + 大小做戳，落 ``viewer/_gen/vfx.bundle.js``（不入库）。
戳盖的是**从入口顺着 import 走出来的整棵依赖树**（``sources()`` 现场扫），不是手抄的清单——
手抄清单漏过 ``vfxPlate.ts`` / ``sceneWind.ts``：只改它俩，页面就一直跑旧包，而且不报错。
node 不在 PATH 时退回 ``.tools/node``（Windows 便携 node，见记忆 windows-dev-entrypoint）。
打不出来不是致命错：工作台照样能改参数、能存盘，只是**页面不能本地预览、也做不了坐标自证**
（场景芯片会说明）——那时候只能靠联动去游戏里看。
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
#: 页面 import 的运行时模块（命名空间名 = 文件名）。入口与戳都从这一张表派生。
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
    # 薄片可燃（vfxSim 本来就 import 它，戳里早有；单列出来是给页面一个命名空间：燃烧预览按 plateBurnProgress 画焦黑，
    # 自检拿 resolvePlateBurnParams 对账模板参数——不在 JS 里另写）
    SRC / "systems" / "vfx" / "vfxPlateBurn.ts",
    # 可燃物模板清洗（页面命名空间 burnables）：/api/burnables 的原始文档过 resolveBurnable(doc, id) 装成 burnTemplates，
    # 与游戏 VfxSystem.loadBurnTemplate 同一个函数——页面里不许另写清洗 / 缺省
    SRC / "data" / "burnables.ts",
    # 光柱（体积光）：帧 / 局部坐标 / 形状闸门 / 画面↔世界仿射（vfxSim 本来就 import 它，单列给页面命名空间），
    # 与光柱着色的**同一段 GLSL 核心 + 同一个 uniform 打包函数**（原画视图的 WebGL 预览层编译它，不在 JS 里另写着色）
    SRC / "systems" / "vfx" / "vfxBeam.ts",
    SRC / "rendering" / "vfx" / "vfxBeamGlsl.ts",
    # 雷（现画）：形状（vfxBolt）与画法（逐段卷积的 GLSL 核 + 挑细分级 / 定粗细 / 剔除的逐段发放）——
    # 雷电样式那一节的预览与原画视图里的雷编译的就是这两份，不在 JS 里另写
    SRC / "systems" / "vfx" / "vfxBolt.ts",
    SRC / "rendering" / "vfx" / "vfxBoltGlsl.ts",
]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "vfx.bundle.js"
STAMP = GEN_DIR / "vfx.bundle.stamp.json"
BUILD_SCRIPT = GEN_DIR / "build_bundle.cjs"
ENTRY = GEN_DIR / "entry.ts"

#: 相对路径的值 import / re-export（`import type` / `export type` 打包时整条擦掉，不进戳）
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
    lines = ["// 由 tools/vfx_workbench/bundle.py 生成：粒子模拟核心 + 画面↔M-world 换算，同一份代码打给工作台页面。"]
    for p in ENTRY_MODULES:
        rel = os.path.relpath(p, GEN_DIR).replace(os.sep, "/")
        lines.append(f"export * as {p.stem} from '{rel}';")
    return "\n".join(lines) + "\n"


_BUILD_JS = r"""
// 由 tools/vfx_workbench/bundle.py 生成：把 _gen/entry.ts（ENTRY_MODULES 那几个运行时模块）打成 ESM。
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
    """返回 (包路径, 错误说明)。包已是最新就不动。"""
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
        proc = subprocess.run(
            [node, str(BUILD_SCRIPT), str(ENTRY), str(OUT)],
            cwd=str(ROOT), capture_output=True, text=True, timeout=180,
            env={**os.environ, "NODE_NO_WARNINGS": "1"},
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return (OUT if OUT.exists() else None), f"rolldown 打包失败: {e}"
    if proc.returncode != 0 or not OUT.exists():
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
        return (OUT if OUT.exists() else None), "rolldown 打包失败:\n" + "\n".join(tail)
    STAMP.write_text(json.dumps(want), encoding="utf-8")
    return OUT, ""


if __name__ == "__main__":
    p, err = ensure_bundle(force="--force" in sys.argv)
    print(p or "(none)", err or "ok")
    sys.exit(0 if p and not err else 1)
