"""Single resolution point for the project interpreter and node toolchain."""

from __future__ import annotations

import os
import platform
import shutil
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def unix_venv_python() -> Path:
    return repo_root() / ".tools" / "venv" / "bin" / "python"


def windows_venv_python() -> Path:
    return repo_root() / ".tools" / "venv" / "Scripts" / "python.exe"


def platform_venv_python() -> Path:
    if platform.system() == "Windows":
        return windows_venv_python()
    return unix_venv_python()


def project_python() -> Path:
    """Resolve the project-managed Python interpreter.

    Falls back to the running interpreter when the venv is still being created.
    """
    candidate = platform_venv_python()
    if candidate.is_file():
        return candidate
    return Path(sys.executable).resolve()


def project_python_ready() -> bool:
    if platform_venv_python().is_file():
        return True
    # Windows developers often launch the console from an already-prepared
    # Python install before the project venv exists. Keep Unix bootstrap
    # behavior unchanged while allowing that Windows path to run tools.
    return platform.system() == "Windows" and Path(sys.executable).is_file()


def _unix_node_candidate_dirs() -> list[Path]:
    home = Path.home()
    dirs = [
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        home / ".volta" / "bin",
    ]
    nvm_dir = os.environ.get("NVM_DIR", "")
    if nvm_dir:
        current = Path(nvm_dir) / "current" / "bin"
        if current.is_dir():
            dirs.insert(0, current)
    return dirs


def _windows_node_candidate_dirs() -> list[Path]:
    """Windows 上 node 可能在哪，仓库自带的便携版排第一。

    GUI 起的进程（主编辑器、dev 控制台）继承的是父进程那份环境，改过用户 PATH
    也要整条进程链重启才看得见；在那之前 `shutil.which("node")` 一定落空。此前
    Windows 落空后没有任何兜底（候选目录只有 homebrew/volta/nvm 这些 POSIX 路径），
    于是 npm_command() 退回裸 "npm.cmd"，cmd.exe 找不到就是 WinError 2。而这份
    运行时本来就在 resources/vendor_archives/node-portable-win-x64.zip 里发着，
    解到 .tools/node 就该被认出来，不必让人反复重启刷 PATH。
    """
    dirs: list[Path] = []
    vendored = repo_root() / ".tools" / "node"
    if vendored.is_dir():
        # 解压出来的顶层目录带版本号（node-v22.14.0-win-x64），别写死版本。
        dirs.extend(sorted(child for child in vendored.iterdir() if child.is_dir()))
        dirs.append(vendored)
    nvm_link = os.environ.get("NVM_SYMLINK", "")
    if nvm_link:
        dirs.append(Path(nvm_link))
    for env_name, tail in (
        ("ProgramFiles", "nodejs"),
        ("ProgramFiles(x86)", "nodejs"),
        ("LOCALAPPDATA", "Programs/nodejs"),
    ):
        base = os.environ.get(env_name, "")
        if base:
            dirs.append(Path(base) / tail)
    return dirs


def _node_exe_names() -> tuple[str, ...]:
    """可执行文件名：Windows 上是 node.exe / npm.cmd，不是裸 node / npm。"""
    if platform.system() == "Windows":
        return ("node.exe", "npm.cmd", "npm.exe")
    return ("node", "npm")


def node_dir() -> Path | None:
    """Directory containing node/npm, or None when not found."""
    for tool in ("node", "npm"):
        found = shutil.which(tool)
        if found:
            return Path(found).parent
    if platform.system() == "Windows":
        candidates = _windows_node_candidate_dirs()
    else:
        candidates = _unix_node_candidate_dirs()
    names = _node_exe_names()
    for d in candidates:
        if any((d / name).is_file() for name in names):
            return d
    return None


def npm_command() -> str:
    """Full npm invocation path when resolvable, else bare command name."""
    d = node_dir()
    if platform.system() == "Windows":
        names = ("npm.cmd", "npm.exe", "npm")
    else:
        names = ("npm",)
    if d is not None:
        for name in names:
            candidate = d / name
            if candidate.is_file():
                return str(candidate)
    return names[0]


def env_with_node_path(base: dict[str, str] | None = None) -> dict[str, str]:
    """Copy of the environment with node's directory prepended to PATH."""
    env = dict(os.environ if base is None else base)
    d = node_dir()
    if d is not None:
        env["PATH"] = str(d) + os.pathsep + env.get("PATH", "")
    return env
