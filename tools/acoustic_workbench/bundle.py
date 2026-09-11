# -*- coding: utf-8 -*-
"""把运行时的 ``src/audio/acousticSpace.ts`` + ``src/utils/sceneSpace.ts`` 打成一个 ESM 包给工作台页面用。

为什么不在 JS 里再写一份抽头 / IR：制作人 2026-09-07 定「只做实时、不做离线烘焙——两套实现必然漂移」，
同理工作台里显示的抽头表、IR 波形、首回提示必须**就是游戏算的那份**。所以这里不镜像任何数学，
只把那几个 TS 模块用仓库自带的 rolldown（vite 8 的打包器）打成浏览器能 import 的 ESM。

``sceneSpace``（画面点 ↔ M-world 的**唯一实现**，运行时听者就是它算的）一并打进来，页面装场景后拿同一批
画面点分别过它与工作台自己的 SceneCal / 服务端的 world，对不上就红字——「工作台的世界 = 运行时的世界」
不靠口头保证，靠这道自证（2026-09-08 制作人：镜像一次就再也不信"应该对了"）。

缓存：按几个 TS 源文件 mtime + 大小做戳，落 ``viewer/_gen/acoustic.bundle.js``（不入库）。
node 不在 PATH 时退回 ``.tools/node``（Windows 便携 node，见记忆 windows-dev-entrypoint）。
打不出来不是致命错：工作台照样能摆几何、能存盘，只是本地不显示抽头（页面会说明）。
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
SRC = ROOT / "src" / "audio" / "acousticSpace.ts"
SCENE_SPACE = ROOT / "src" / "utils" / "sceneSpace.ts"
# 戳要盖住入口的整棵依赖树：改了 worldReconstruct 而包不重打，页面里的"运行时换算"就是旧的
SRCS = [SRC, SCENE_SPACE, ROOT / "src" / "utils" / "worldReconstruct.ts", ROOT / "src" / "utils" / "groundDepthField.ts"]
GEN_DIR = TOOL / "viewer" / "_gen"
OUT = GEN_DIR / "acoustic.bundle.js"
STAMP = GEN_DIR / "acoustic.bundle.stamp.json"
BUILD_SCRIPT = GEN_DIR / "build_bundle.cjs"
ENTRY = GEN_DIR / "entry.ts"

_ENTRY_TS = """// 由 tools/acoustic_workbench/bundle.py 生成：运行时声学 + 画面↔M-world 换算，同一份代码打给工作台页面。
export * from '../../../../src/audio/acousticSpace.ts';
export * as sceneSpace from '../../../../src/utils/sceneSpace.ts';
"""

_BUILD_JS = r"""
// 由 tools/acoustic_workbench/bundle.py 生成：把 _gen/entry.ts（acousticSpace + sceneSpace）打成 ESM。
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
