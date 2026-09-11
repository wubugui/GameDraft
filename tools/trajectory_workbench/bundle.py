# -*- coding: utf-8 -*-
"""把运行时的 ``src/utils/sceneSpace.ts`` + ``src/utils/trajectoryProjection.ts`` 打成 ESM 给工作台页面用。

为什么要打包而不是在 JS 里再写一份：工作台是**唯一**写 ``public/assets/data/trajectories/`` 的地方，
作者在这里摆的点、看的预览，就是游戏开播时要走的那条投影。两边各写一份数学必然漂移，而且
**漂了一处都不报错**——投影与拾取共用同一套换算，自洽得很，只有拿原画 / 拿游戏对着看才发现
（2026-09-08 声学工作台镜像、2026-09-10 这里镜像，两次都是这个形状）。所以这里不镜像任何数学，
只把那两个 TS 模块用仓库自带的 rolldown（vite 8 的打包器）打成浏览器能 import 的 ESM，页面装完场景
跑一道自证：同一批画面点 / 同一批 3D 位移分别过**运行时的**函数与工作台自己的 SceneCal，对不上就红字。

覆盖的两条口径（正是"bake 出来的东西游戏里对不对得上"的两半）：
  * ``sceneSpace.groundWorldAt``      画面点 → M-world 地面点：作者点哪里 = 运行时认为的哪里
  * ``trajectoryProjection.projectWorldOffset``  3D 相对位移 → 画面偏移：预览里的形状 = 开播时的形状

⚠ Python 侧另有一份 ``projection.py`` 镜像，与 TS 之间已有跨语言金标
``src/utils/trajectoryProjection.golden.json``（``tests/test_projection.py`` 逐位比）。那道门管**落盘**，
这道自证管**页面**，两道都要，缺一边就是"存进去的对、看到的不对"。

缓存：按几个 TS 源文件 mtime + 大小做戳，落 ``viewer/_gen/runtime.bundle.js``（不入库）。
node 不在 PATH 时退回 ``.tools/node``（Windows 便携 node，见记忆 windows-dev-entrypoint）。
打不出来不是致命错：工作台照样能摆点、能存盘、能烘焙，只是页面不显示对齐自证（场景芯片会说明）。
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
SCENE_SPACE = ROOT / "src" / "utils" / "sceneSpace.ts"
TRAJ_PROJ = ROOT / "src" / "utils" / "trajectoryProjection.ts"
# 戳要盖住入口的整棵依赖树：改了 worldReconstruct 而包不重打，页面里的"运行时换算"就是旧的
SRCS = [SCENE_SPACE, TRAJ_PROJ,
        ROOT / "src" / "utils" / "worldReconstruct.ts",
        ROOT / "src" / "utils" / "groundDepthField.ts"]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "runtime.bundle.js"
STAMP = GEN_DIR / "runtime.bundle.stamp.json"
BUILD_SCRIPT = GEN_DIR / "build_bundle.cjs"
ENTRY = GEN_DIR / "entry.ts"

_ENTRY_TS = """// 由 tools/trajectory_workbench/bundle.py 生成：画面↔M-world 换算 + 轨迹投影，同一份代码打给工作台页面。
export * as sceneSpace from '../../../../src/utils/sceneSpace.ts';
export * as trajectoryProjection from '../../../../src/utils/trajectoryProjection.ts';
"""

_BUILD_JS = r"""
// 由 tools/trajectory_workbench/bundle.py 生成：把 _gen/entry.ts（sceneSpace + trajectoryProjection）打成 ESM。
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
            cwd=str(ROOT), capture_output=True, text=True, timeout=120,
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
