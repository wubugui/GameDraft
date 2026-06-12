"""Single resolution point for the project interpreter and node toolchain."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def unix_venv_python() -> Path:
    return repo_root() / ".tools" / "venv" / "bin" / "python"


def project_python() -> Path:
    """Resolve the project-managed Python interpreter.

    Falls back to the running interpreter when the venv is still being created.
    """
    candidate = unix_venv_python()
    if candidate.is_file():
        return candidate
    return Path(sys.executable).resolve()


def project_python_ready() -> bool:
    return unix_venv_python().is_file()


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


def node_dir() -> Path | None:
    """Directory containing node/npm, or None when not found."""
    for tool in ("node", "npm"):
        found = shutil.which(tool)
        if found:
            return Path(found).parent
    for d in _unix_node_candidate_dirs():
        if (d / "node").is_file() or (d / "npm").is_file():
            return d
    return None


def npm_command() -> str:
    """Full npm invocation path when resolvable, else bare command name."""
    name = "npm"
    d = node_dir()
    if d is not None and (d / name).is_file():
        return str(d / name)
    return name


def env_with_node_path(base: dict[str, str] | None = None) -> dict[str, str]:
    """Copy of the environment with node's directory prepended to PATH."""
    env = dict(os.environ if base is None else base)
    d = node_dir()
    if d is not None:
        env["PATH"] = str(d) + os.pathsep + env.get("PATH", "")
    return env
