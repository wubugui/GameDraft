# -*- coding: utf-8 -*-
"""工作台 RHI 接入层 · Python 侧：按需把工作台的 TS 入口打成 ESM 包（``build.mjs``，vite 库模式）。

  from tools.workbench_rhi import build as wbrhi
  path, err = wbrhi.ensure(entry_ts, out_js)        # 最新就一个字节都不写；过期 / 没有才打

* **判新旧**：``build.mjs`` 打完在产物旁边写 ``<名>.stamp.json``——本次实际打进去的每个源文件（游戏 src、工作台胶水、
  node_modules 里的依赖、package-lock.json）的尺寸 + 修改时刻，外加打包器自身的摘要。任何一个对不上 / 文件没了 / 入口换了
  ⇒ 重打。清单是打包器自己报的，不靠正则猜 import（``?raw`` 的 WGSL、``@src`` 别名都算得上）。
* **产物不进 git**：放在调用方给的目录（约定各工作台 ``viewer/_gen/``，已 gitignore）；第一次打开工作台时现打。
* **打不出来不致命**：没有 node / vite 报错时返回 ``(旧包或 None, 原因)``——页面照样能改能存，着色预览显示原因。
* **进程内串行**：同一产物同时只打一次（serve 的多个请求线程并发时不会两个 node 抢着写）。
* 纯本地、跨平台：只调 ``node``（PATH 或 ``.tools/node``）与仓库根 ``node_modules``，不联网、不碰平台特定路径。
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BUILDER = HERE / "build.mjs"
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()
_MTIME_EPS_MS = 0.5


def node_exe() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for p in sorted(glob.glob(str(ROOT / ".tools" / "node" / "*" / "node*"))):
        if Path(p).name in ("node", "node.exe") and Path(p).is_file():
            return p
    for p in sorted(glob.glob(str(ROOT / ".tools" / "node" / "*" / "bin" / "node"))):
        return p
    return None


def stamp_path(out: Path) -> Path:
    return out.with_name(out.name[: -len(".js")] + ".stamp.json")


def _builder_digest() -> str:
    import hashlib
    return hashlib.sha1(BUILDER.read_bytes()).hexdigest()


def stale_reason(entry: Path, out: Path) -> str:
    """产物是最新的返回 ''；否则返回为什么要重打（给日志 / 页面看）。只读，不写任何东西。"""
    out = Path(out)
    if not out.is_file():
        return "还没打过"
    sp = stamp_path(out)
    try:
        stamp = json.loads(sp.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "没有打包戳"
    if stamp.get("version") != 1:
        return "打包戳版本不对"
    if os.path.normcase(os.path.abspath(str(stamp.get("entry") or ""))) != os.path.normcase(os.path.abspath(str(entry))):
        return "入口换了"
    if stamp.get("builder") != _builder_digest():
        return "打包器改了"
    inputs = stamp.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        return "打包戳里没有源清单"
    for rec in inputs:
        try:
            st = os.stat(rec["path"])
        except (OSError, KeyError, TypeError):
            return f"源文件没了：{rec.get('path') if isinstance(rec, dict) else rec}"
        if st.st_size != rec.get("size") or abs(st.st_mtime_ns / 1e6 - float(rec.get("mtimeMs") or 0)) > _MTIME_EPS_MS:
            return f"源文件变了：{rec['path']}"
    return ""


def inputs_of(out: Path) -> list[Path]:
    """上一次打包实际用到的源文件（没打过 = 空）。"""
    try:
        stamp = json.loads(stamp_path(Path(out)).read_text(encoding="utf-8"))
        return [Path(r["path"]) for r in stamp.get("inputs") or []]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def _lock_for(out: Path) -> threading.Lock:
    key = os.path.normcase(os.path.abspath(str(out)))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def ensure(entry: Path, out: Path, *, force: bool = False, timeout: float = 300.0) -> tuple[Path | None, str]:
    """返回 (产物路径, 错误说明)。最新就直接返回；打不出来时有旧包就返回旧包 + 原因，没有返回 None + 原因。"""
    entry, out = Path(entry), Path(out)
    with _lock_for(out):
        if not force and not stale_reason(entry, out):
            return out, ""
        old = out if out.is_file() else None
        if not entry.is_file():
            return old, f"打包入口不存在：{entry}"
        node = node_exe()
        if not node:
            return old, "找不到 node（PATH 与 .tools/node 都没有），无法打工作台渲染包"
        if not (ROOT / "node_modules" / "vite").is_dir():
            return old, "仓库根没有 node_modules/vite（先在仓库根 npm ci）"
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            proc = subprocess.run([node, str(BUILDER), str(entry), str(out)], cwd=str(ROOT), capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=timeout,
                                  env={**os.environ, "NODE_NO_WARNINGS": "1"})
        except (OSError, subprocess.TimeoutExpired) as e:
            return old, f"vite 打包失败：{e}"
        if proc.returncode != 0 or not out.is_file():
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-8:]
            return (out if out.is_file() else None), "vite 打包失败：\n" + "\n".join(tail)
        return out, ""


# ----------------------------------------------------------------------------- 入口文件（生成式）
_SAFE_NS = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def entry_source(modules: list[Path], at: Path, header: str = "") -> str:
    """``export * as <文件名> from '<相对路径>'`` 一行一个（命名空间 = 文件名去扩展名）。"""
    lines = [f"// {header}" if header else "// 由 tools/workbench_rhi/build.py 生成"]
    seen: set[str] = set()
    for p in modules:
        ns = p.stem
        if not _SAFE_NS.match(ns) or ns in seen:
            raise ValueError(f"命名空间不合法或重名：{ns}（{p}）")
        seen.add(ns)
        try:
            rel = os.path.relpath(p, at.parent).replace(os.sep, "/")
            if not rel.startswith("."):
                rel = "./" + rel
        except ValueError:  # Windows 上入口与源不在同一个盘：用绝对路径（正斜杠，vite 认）
            rel = Path(p).resolve().as_posix()
        lines.append(f"export * as {ns} from '{rel}';")
    return "\n".join(lines) + "\n"


def write_if_changed(path: Path, text: str) -> bool:
    """内容一样就不写（没改源时一个字节都不落盘，mtime 不动、打包戳照旧有效）。"""
    try:
        if path.read_text(encoding="utf-8") == text:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


# ----------------------------------------------------------------------------- 源依赖树（打之前的近似，给测试 / 报告用）
_IMPORT_RE = re.compile(r"""^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}/[^'"]+)['"]""", re.M)


def _resolve(base: Path, spec: str) -> Path | None:
    p = (base.parent / spec.split("?")[0]).resolve()
    for cand in (p, p.with_name(p.name + ".ts"), p / "index.ts"):
        if cand.is_file():
            return cand
    return None


def import_tree(entries: list[Path]) -> list[Path]:
    """入口顺着相对值 import（含 ``?raw``）走出来的仓库内源文件。只是打之前的近似：权威清单是打包戳。"""
    seen: dict[Path, None] = {}
    todo = [Path(p).resolve() for p in entries]
    while todo:
        p = todo.pop(0)
        if p in seen:
            continue
        seen[p] = None
        if p.suffix not in (".ts", ".js", ".mjs"):
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
