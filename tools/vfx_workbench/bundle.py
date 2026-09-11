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

缓存：按 TS 源文件 mtime + 大小做戳，落 ``viewer/_gen/vfx.bundle.js``（不入库）。
node 不在 PATH 时退回 ``.tools/node``（Windows 便携 node，见记忆 windows-dev-entrypoint）。
打不出来不是致命错：工作台照样能改参数、能存盘，只是**页面不能本地预览、也做不了坐标自证**
（场景芯片会说明）——那时候只能靠联动去游戏里看。
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
SRC = ROOT / "src"
# 戳要盖住入口的整棵依赖树：改了 worldReconstruct 而包不重打，页面里的"运行时换算"就是旧的
SRCS = [
    SRC / "systems" / "vfx" / "vfxSim.ts",
    SRC / "systems" / "vfx" / "vfxSpace.ts",
    SRC / "systems" / "vfx" / "vfxNoise.ts",
    SRC / "systems" / "vfx" / "vfxRandom.ts",
    SRC / "utils" / "sceneSpace.ts",
    SRC / "utils" / "depthShellField.ts",
    SRC / "utils" / "groundHeightfield.ts",
    SRC / "utils" / "worldReconstruct.ts",
    SRC / "utils" / "groundDepthField.ts",
]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "vfx.bundle.js"
STAMP = GEN_DIR / "vfx.bundle.stamp.json"
BUILD_SCRIPT = GEN_DIR / "build_bundle.cjs"
ENTRY = GEN_DIR / "entry.ts"

_ENTRY_TS = """// 由 tools/vfx_workbench/bundle.py 生成：粒子模拟核心 + 画面↔M-world 换算，同一份代码打给工作台页面。
export * as vfxSim from '../../../../src/systems/vfx/vfxSim.ts';
export * as vfxSpace from '../../../../src/systems/vfx/vfxSpace.ts';
export * as sceneSpace from '../../../../src/utils/sceneSpace.ts';
export * as depthShellField from '../../../../src/utils/depthShellField.ts';
export * as groundHeightfield from '../../../../src/utils/groundHeightfield.ts';
"""

_BUILD_JS = r"""
// 由 tools/vfx_workbench/bundle.py 生成：把 _gen/entry.ts（vfxSim + vfxSpace + sceneSpace + 两个场）打成 ESM。
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


def _stamp() -> dict:
    return {"srcs": [{"src": str(p), "mtime": p.stat().st_mtime, "size": p.stat().st_size} for p in SRCS],
            "entry": _ENTRY_TS}


def ensure_bundle(force: bool = False) -> tuple[Path | None, str]:
    """返回 (包路径, 错误说明)。包已是最新就不动。"""
    for p in SRCS:
        if not p.exists():
            return None, f"运行时模块不存在: {p}"
    want = _stamp()
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
    ENTRY.write_text(_ENTRY_TS, encoding="utf-8", newline="\n")
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
