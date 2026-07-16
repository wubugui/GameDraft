"""Dependency installation for macOS/Linux."""

from __future__ import annotations

import subprocess
from pathlib import Path

from tools.dev import proxyenv
from tools.dev.paths import env_with_node_path, npm_command, project_python, repo_root

EDITOR_REQUIREMENTS = "tools/editor/requirements.txt"
DEPS_CONSTRAINTS = "config/python-deps-constraints.txt"


def _pip(
    args: list[str],
    description: str,
    env: dict[str, str] | None = None,
    proxy_url: str = "",
) -> None:
    pip_args = list(args)
    if pip_args and pip_args[0] == "install":
        pip_args = ["install", "--progress-bar", "raw", *pip_args[1:]]
    if proxy_url:
        pip_args = ["--proxy", proxy_url, *pip_args]
    rc = subprocess.call(
        [str(project_python()), "-m", "pip", *pip_args],
        cwd=str(repo_root()),
        env=env,
    )
    if rc != 0:
        raise SystemExit(f"{description} failed with exit code {rc}")


def _all_tool_requirements() -> list[Path]:
    return sorted(repo_root().glob("tools/*/requirements.txt"))


def _install_extra_tools(
    names: str,
    env: dict[str, str] | None = None,
    proxy_url: str = "",
) -> None:
    root = repo_root()
    if names == "all":
        files = _all_tool_requirements()
    else:
        files = [root / "tools" / n / "requirements.txt" for n in names.split(",") if n]
    for req in files:
        if req.is_file():
            print(f"Installing {req.relative_to(root)} ...")
            _pip(
                ["install", "-r", str(req)],
                f"Installing {req.name}",
                env=env,
                proxy_url=proxy_url,
            )


def install_deps(
    skip_dvc_pull: bool = False,
    tools: str | None = None,
    npm_proxy: str | None = None,
    no_proxy: bool = False,
) -> int:
    install_env = None
    proxy_url = ""
    if not no_proxy:
        install_env = env_with_node_path()
        proxy_url = proxyenv.git_proxy_url(npm_proxy or "")
        install_env.update(proxyenv.loopback_safe_proxy_env(proxy_url))
        print(f"install-deps via temporary proxy {proxy_url}", flush=True)
        print(f"pip --proxy {proxy_url}", flush=True)

    _pip(
        ["install", "-c", DEPS_CONSTRAINTS, "dvc", "dvc-oss"],
        "Installing DVC dependencies",
        env=install_env,
        proxy_url=proxy_url,
    )
    _pip(
        ["install", "-r", EDITOR_REQUIREMENTS],
        "Installing editor dependencies",
        env=install_env,
        proxy_url=proxy_url,
    )
    if tools:
        _install_extra_tools(tools, env=install_env, proxy_url=proxy_url)

    if not (repo_root() / "node_modules").is_dir():
        env = install_env or env_with_node_path()
        npm = npm_command()
        rc = subprocess.call([npm, "install"], cwd=str(repo_root()), env=env)
        if rc != 0:
            raise SystemExit(f"npm install failed with exit code {rc}")

    print("Dependencies installed.")
    return 0
