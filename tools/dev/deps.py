"""Dependency installation for macOS/Linux."""

from __future__ import annotations

import subprocess
from pathlib import Path

from tools.dev import proxyenv
from tools.dev.paths import env_with_node_path, npm_command, project_python, repo_root

EDITOR_REQUIREMENTS = "tools/editor/requirements.txt"
DEPS_CONSTRAINTS = "config/python-deps-constraints.txt"


def _pip(args: list[str], description: str, env: dict[str, str] | None = None) -> None:
    rc = subprocess.call(
        [str(project_python()), "-m", "pip", *args], cwd=str(repo_root()), env=env
    )
    if rc != 0:
        raise SystemExit(f"{description} failed with exit code {rc}")


def _all_tool_requirements() -> list[Path]:
    return sorted(repo_root().glob("tools/*/requirements.txt"))


def _install_extra_tools(names: str) -> None:
    root = repo_root()
    if names == "all":
        files = _all_tool_requirements()
    else:
        files = [root / "tools" / n / "requirements.txt" for n in names.split(",") if n]
    for req in files:
        if req.is_file():
            print(f"Installing {req.relative_to(root)} ...")
            _pip(["install", "-r", str(req)], f"Installing {req.name}")


def install_deps(
    skip_dvc_pull: bool = False,
    tools: str | None = None,
    npm_proxy: str | None = None,
) -> int:
    # PyPI phase respects the user's PIP_INDEX_URL / proxy env.
    _pip(
        ["install", "-c", DEPS_CONSTRAINTS, "dvc", "dvc-oss"],
        "Installing DVC dependencies",
    )
    _pip(
        ["install", "-r", EDITOR_REQUIREMENTS],
        "Installing editor dependencies",
    )
    if tools:
        _install_extra_tools(tools)

    if not (repo_root() / "node_modules").is_dir():
        env = env_with_node_path()
        if npm_proxy is not None:
            env.update(proxyenv.loopback_safe_proxy_env(npm_proxy))
            print(f"npm install via proxy {env['HTTP_PROXY']}")
        npm = npm_command()
        rc = subprocess.call([npm, "install"], cwd=str(repo_root()), env=env)
        if rc != 0:
            raise SystemExit(f"npm install failed with exit code {rc}")

    print("Dependencies installed.")
    return 0
