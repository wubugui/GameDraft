"""编辑器里所有 npm 子进程调用的单一出口（program/args 与 PATH 补全）。

两条平台坑各有各的绕法，以前分别散在各处：

- **Windows**：npm 是 `npm.cmd` 批处理，且 GUI 起的进程继承的是父进程那份 PATH
  （改过用户 PATH 也要整条进程链重启才看得见）。
- **macOS/Linux**：Finder/Dock 起的进程 PATH 精简，homebrew/volta/nvm 的 node 不在里面。

叙事状态机的「重建并刷新」曾经自己手搓过一份**只有 POSIX 版**的调用
（`$SHELL -lc …`，回落 `/bin/zsh`）：Windows 上 `SHELL` 为空 ⇒ 程序名指向一个不存在的
路径 ⇒ QProcess 必然 FailedToStart，那个按钮从来没能在 Windows 上跑通。收在这里就是
为了不再出现第二份手搓版。
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from PySide6.QtCore import QProcessEnvironment

from tools.dev.paths import env_with_node_path, node_command, npm_command


def augment_env_for_nodejs(env: QProcessEnvironment) -> None:
    """GUI 启动的进程常缺少终端里的 PATH；补全常见 Node/npm 目录。"""
    path_key = "PATH"
    if not env.contains(path_key):
        for alt in ("PATH", "Path"):
            if env.contains(alt):
                path_key = alt
                break
    current = env.value(path_key, "")
    prefixes: list[str] = []

    npm = shutil.which("npm")
    if npm:
        prefixes.append(str(Path(npm).resolve().parent))

        nvm_link = os.environ.get("NVM_SYMLINK", "")
        if nvm_link and os.path.isdir(nvm_link):
            prefixes.insert(0, nvm_link)
    else:
        # macOS/Linux: GUI launches (Finder/Dock) often start with a minimal
        # PATH that omits Homebrew / volta / nvm node installs.
        home = os.path.expanduser("~")
        for d in (
            "/opt/homebrew/bin",
            "/usr/local/bin",
            os.path.join(home, ".volta", "bin"),
        ):
            if os.path.isdir(d):
                prefixes.append(d)
        nvm_dir = os.environ.get("NVM_DIR", "")
        if nvm_dir:
            nvm_current = os.path.join(nvm_dir, "current", "bin")
            if os.path.isdir(nvm_current):
                prefixes.insert(0, nvm_current)

    seen: set[str] = set()
    merged: list[str] = []
    for p in prefixes:
        if not p:
            continue
        norm = os.path.normcase(os.path.abspath(p))
        if os.path.isdir(p) and norm not in seen:
            seen.add(norm)
            merged.append(p)
    if merged:
        env.insert(path_key, os.pathsep.join(merged) + os.pathsep + current)


def copy_env_to_qprocess(env: QProcessEnvironment, values: dict[str, str]) -> None:
    for key, value in values.items():
        env.insert(key, value)


def npm_run_command(*args: str) -> tuple[str, list[str]]:
    """`npm <args...>` 的 (program, args)。

    Windows 上 npm 是批处理，交给 `%ComSpec% /d /c` 解释（`/d` 跳过 AutoRun 注册表钩子，
    免得别人机器上的 AutoRun 脚本污染输出与退出码）。
    """
    npm = npm_command()
    if os.name == "nt":
        comspec = os.environ.get("ComSpec") or "cmd.exe"
        return comspec, ["/d", "/c", npm, *args]
    return npm, list(args)


def node_script_command(script_rel: str, *args: str) -> tuple[str, list[str]]:
    """直接用 node 跑仓库里的一个脚本的 (program, args)。

    与 :func:`npm_run_command` 的区别：**不经 cmd、不经 npm**。

    Windows 上 `npm` 是批处理，只能交给 `cmd /d /c` 解释，于是参数要过一遍 cmd 的
    引号规则——**带空格的路径**（`--out-dir "D:\\我的 构建"`）在这一层极易被拆错，
    而且拆错的表现是"跑起来了但去了别的目录"，比直接报错难查得多。
    直接调 node 就没有这一层：QProcess 自己按 Windows 的参数规则转义。

    需要传路径参数的调用一律走这条；`npm run <script>` 那条留给不带参数的固定任务。
    """
    return node_command(), [script_rel, *args]


def node_process_environment() -> QProcessEnvironment:
    """跑 npm 用的进程环境：系统环境 + 仓库自带 node 目录 + GUI 兜底补全。"""
    env = QProcessEnvironment.systemEnvironment()
    copy_env_to_qprocess(env, env_with_node_path())
    augment_env_for_nodejs(env)
    return env
