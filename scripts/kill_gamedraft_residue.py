# -*- coding: utf-8 -*-
"""杀本项目的游戏运行时 / 编辑器 / 工作台残留进程。

    sh scripts/py.sh scripts/kill_gamedraft_residue.py            # 列出并杀
    sh scripts/py.sh scripts/kill_gamedraft_residue.py --dry-run  # 只列不杀

认进程靠**身份**(可执行文件 / 模块 / 工作目录 / 专用 profile),不靠端口——
dev server 端口会顺延(5173~5180、扫场 5195+),工作台端口由系统分配,按端口杀必漏。

认得的:
- 打包版游戏 gamedraft.exe(连同它的 WebView2 子进程)
- 游戏预览窗:带 ``GameDraft\\preview-profile`` 的专用 Chromium 实例(tools/dev/game_preview.py)
- vite dev server / scripts/dev_agent.cjs / scripts/scene_sweep.mjs / tauri dev(工作目录或路径在仓库内)
- 仓库内 python 跑的 ``tools.*`` 编辑器、工作台、控制台、手册站、烘焙子任务
- 仓库 .tools 下的孤儿 QtWebEngineProcess

不碰的:MCP server(属于正在用的 AI 会话)、pytest / 校验 / 审计这类一次性命令、
git、shell、VS Code、Claude/Codex 本体,以及本脚本自己和它的祖先进程。
"""
from __future__ import annotations

import argparse
import io
import os
import subprocess
import sys
import time
from pathlib import Path

import psutil

REPO = Path(__file__).resolve().parents[1]
REPO_KEY = str(REPO).replace("/", "\\").lower().rstrip("\\") + "\\"

# python 侧:模块名/脚本路径命中这些片段就**不算**残留(一次性命令或属于 AI 会话)
PY_EXCLUDE = (
    "mcp", "pytest", "tools.editor.validate", "audit_depth", "audit_walkable",
    "placeholder_audit", "json_lang", "skill_workflow_governance.govern", "agent_hooks",
)
# tools.dev 的这些子命令是同步/安装类,不是工具进程
DEV_NON_TOOL = {"bootstrap", "install-deps", "init-runtime", "init-editor", "init-audio",
                "configure-oss", "pull", "push", "commit"}
AGENT_HOSTS = {"claude.exe": "Claude", "codex.exe": "Codex", "chatgpt.exe": "Codex",
               "code.exe": "VS Code", "cursor.exe": "Cursor", "workbuddy.exe": "WorkBuddy"}


def norm(s: str) -> str:
    return (s or "").replace("/", "\\").lower()


def in_repo(path: str) -> bool:
    return norm(path).startswith(REPO_KEY)


def info(p: psutil.Process) -> dict | None:
    try:
        with p.oneshot():
            d = {"pid": p.pid, "ppid": p.ppid(), "name": (p.name() or "").lower(),
                 "cmd": p.cmdline(), "create": p.create_time(), "mem": p.memory_info().rss}
            try:
                d["exe"] = p.exe()
            except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
                d["exe"] = ""
            try:
                d["cwd"] = p.cwd()
            except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
                d["cwd"] = ""
        return d
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
        return None


def classify(d: dict) -> str | None:
    name, cmd = d["name"], d["cmd"]
    joined = norm(" ".join(cmd))
    repo_ctx = in_repo(d["exe"]) or in_repo(d["cwd"]) or REPO_KEY in joined

    if name == "gamedraft.exe":
        return "游戏(打包版)"
    if name == "msedgewebview2.exe" and "--webview-exe-name=gamedraft.exe" in joined:
        return "游戏(打包版)WebView2"
    if name in ("chrome.exe", "msedge.exe", "chromium.exe") and "gamedraft\\preview-profile" in joined:
        return "游戏预览窗(专用 Chromium)"
    if name == "qtwebengineprocess.exe" and in_repo(d["exe"]):
        return "编辑器内嵌网页进程"

    if name == "node.exe" and repo_ctx and "mcp" not in joined:
        if "vitest" in joined:
            return None
        if "vite\\bin\\vite.js" in joined or "node_modules\\.bin\\vite" in joined:
            return "游戏 dev server(vite)"
        if "dev_agent.cjs" in joined:
            return "游戏 dev server(dev_agent)"
        if "scene_sweep.mjs" in joined:
            return "扫场脚本"
        if "@tauri-apps" in joined or "tauri.js" in joined:
            return "Tauri dev"
        return None

    if name in ("python.exe", "pythonw.exe") and repo_ctx:
        target = ""
        if "-m" in cmd:
            i = cmd.index("-m")
            target = cmd[i + 1] if i + 1 < len(cmd) else ""
            rest = cmd[i + 2:]
        else:
            scripts = [a for a in cmd[1:] if a.endswith(".py")]
            target = scripts[0] if scripts else ""
            rest = []
        t = norm(target)
        if in_repo(t):
            t = t[len(REPO_KEY):]
        t = t.replace("\\", ".")
        if not t.startswith("tools."):
            return None
        if any(x in t or x in joined for x in PY_EXCLUDE):
            return None
        if t == "tools.dev" or t.startswith("tools.dev."):
            sub = next((a for a in rest if not a.startswith("-")), "")
            if t == "tools.dev" and sub in DEV_NON_TOOL:
                return None
            if t.startswith("tools.dev.") and "game_preview" not in t:
                return None
            if sub == "console":
                return "开发控制台"
            if sub == "game":
                return "游戏 dev server(tools.dev game)"
            return f"工具启动器(tools.dev {sub})".replace(" )", ")")
        if "dev_console" in t:
            return "开发控制台"
        if "workbench" in t or "lab" in t or "relight" in t:
            return "工作台"
        if "handbook" in t:
            return "制作人手册站"
        return "编辑器 / 工具"
    return None


def chain(pid: int, by: dict) -> tuple[str, str | None]:
    names, owner, seen = [], None, set()
    cur = by.get(pid, {}).get("ppid")
    while cur and cur not in seen and len(names) < 6:
        seen.add(cur)
        d = by.get(cur)
        if d is None:
            try:
                d = info(psutil.Process(cur))
            except psutil.NoSuchProcess:
                d = None
            if d is None:
                names.append("[父进程已退出]")
                break
        names.append(f"{d['name']}({cur})")
        owner = owner or AGENT_HOSTS.get(d["name"])
        cur = d["ppid"]
    return " <- ".join(names), owner


def listen_ports() -> dict[int, set[int]]:
    out: dict[int, set[int]] = {}
    try:
        for c in psutil.net_connections(kind="tcp"):
            if c.status == psutil.CONN_LISTEN and c.pid and c.laddr:
                out.setdefault(c.pid, set()).add(c.laddr.port)
    except (psutil.AccessDenied, OSError):
        pass
    return out


def subtree(pid: int) -> list[int]:
    try:
        return [pid, *[c.pid for c in psutil.Process(pid).children(recursive=True)]]
    except psutil.NoSuchProcess:
        return []


def kill_tree(pid: int) -> None:
    if sys.platform.startswith("win"):
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        return
    procs = [psutil.Process(x) for x in subtree(pid)]
    for p in procs:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只列出,不杀")
    ap.add_argument("--keep", type=int, action="append", default=[], metavar="PID",
                    help="保留这个 PID(及其整棵子树),可重复")
    args = ap.parse_args()

    protected = {os.getpid()}
    for pid in args.keep:
        protected.update(subtree(pid))  # 整棵子树:只护顶层的话,下一层会被提升成"根"杀掉
    try:
        protected |= {p.pid for p in psutil.Process().parents()}
    except psutil.Error:
        pass

    by: dict[int, dict] = {}
    for p in psutil.process_iter():
        d = info(p)
        if d:
            by[d["pid"]] = d

    hits = {pid: cat for pid, d in by.items() if pid not in protected and (cat := classify(d))}

    # 祖先也命中的只保留最顶层,按树杀
    def has_hit_ancestor(pid: int) -> bool:
        cur, seen = by[pid]["ppid"], set()
        while cur in by and cur not in seen:
            if cur in hits:
                return True
            seen.add(cur)
            cur = by[cur]["ppid"]
        return False

    roots = sorted((pid for pid in hits if not has_hit_ancestor(pid)), key=lambda x: by[x]["create"])
    ports = listen_ports()

    if not roots:
        print("没有找到游戏运行时 / 编辑器 / 工作台残留。")
        return 0

    print(f"找到 {len(roots)} 组残留:" + ("(--dry-run,不杀)" if args.dry_run else ""))
    for pid in roots:
        d = by[pid]
        tree = subtree(pid)
        mem = sum(by[x]["mem"] for x in tree if x in by) // 1048576
        tports = sorted({pt for x in tree for pt in ports.get(x, ())})
        ch, owner = chain(pid, by)
        started = time.strftime("%m-%d %H:%M", time.localtime(d["create"]))
        cmd = " ".join(d["cmd"])
        print(f"- [{hits[pid]}] PID {pid}  启动 {started}  进程 {len(tree)} 个 / {mem} MB"
              f"  端口 {tports or '无'}  来源 {owner or '未知'}")
        print(f"    上游: {ch or '无'}")
        print(f"    命令: {cmd[:220]}")

    if args.dry_run:
        return 0

    for pid in roots:
        kill_tree(pid)
    time.sleep(1.0)
    alive = []
    for pid in roots:
        try:
            if psutil.Process(pid).create_time() == by[pid]["create"]:
                alive.append(pid)
        except psutil.NoSuchProcess:
            pass
    if alive:
        print(f"⚠ 仍存活: {alive}(可能权限不足,需手动处理)")
        return 1
    print(f"已全部结束({len(roots)} 组)。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
