"""Dependency installation, ported from scripts/install-deps.ps1.

Windows keeps the vendored offline flow (DVC vendor_archives → extract
node/node_modules/wheelhouse → offline pip). macOS/Linux install online from
PyPI/npm into the project venv.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

from tools.dev import proxyenv
from tools.dev.paths import env_with_node_path, npm_command, project_python, repo_root

WHEELHOUSE_DIRNAME = "wheelhouse_py311"
VENDOR_NODE_ZIP = "node-portable-win-x64.zip"
VENDOR_NODE_MODULES_ZIP = "node_modules.zip"
VENDOR_WHEELHOUSE_ZIP = "python-wheelhouse-py311.zip"

EDITOR_REQUIREMENTS = "tools/editor/requirements.txt"
DEPS_CONSTRAINTS = "config/python-deps-constraints.txt"


def _pip(args: list[str], description: str, env: dict[str, str] | None = None) -> None:
    rc = subprocess.call(
        [str(project_python()), "-m", "pip", *args], cwd=str(repo_root()), env=env
    )
    if rc != 0:
        raise SystemExit(f"{description} failed with exit code {rc}")


def _extract_zip(archive: Path, dest: Path, *, clean_dest: bool = False) -> None:
    if clean_dest and dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(dest)


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


def _install_windows_vendored(skip_dvc_pull: bool) -> None:
    from tools.dev import bootstrap, sync

    bootstrap.ensure_local_python()
    if not skip_dvc_pull:
        with proxyenv.without_proxy():
            sync.sync_dvc_cache("pull", sync.VENDOR_TARGET)
            sync.run_project_python(["-m", "dvc", "checkout", sync.VENDOR_TARGET])

    root = repo_root()
    vendor = root / "resources" / "vendor_archives"
    node_zip = vendor / VENDOR_NODE_ZIP
    node_modules_zip = vendor / VENDOR_NODE_MODULES_ZIP
    wheelhouse_zip = vendor / VENDOR_WHEELHOUSE_ZIP

    if node_zip.is_file():
        _extract_zip(node_zip, root / ".tools" / "node-portable")
    if node_modules_zip.is_file():
        # node_modules.zip contains node_modules/; replace it wholesale.
        if (root / "node_modules").exists():
            shutil.rmtree(root / "node_modules")
        with zipfile.ZipFile(node_modules_zip) as zf:
            zf.extractall(root)
    if wheelhouse_zip.is_file():
        wheelhouse = root / ".tools" / WHEELHOUSE_DIRNAME
        _extract_zip(wheelhouse_zip, root / ".tools")
        _pip(
            ["install", "--no-index", "--find-links", str(wheelhouse), "-c", DEPS_CONSTRAINTS, "dvc", "dvc-oss"],
            "Installing DVC dependencies",
        )
        _pip(
            ["install", "--no-index", "--find-links", str(wheelhouse), "-r", EDITOR_REQUIREMENTS],
            "Installing editor dependencies",
        )


def _install_unix_online(tools: str | None, npm_proxy: str | None) -> None:
    # PyPI phase respects the user's PIP_INDEX_URL / proxy env — do NOT mask.
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


def install_deps(
    skip_dvc_pull: bool = False,
    tools: str | None = None,
    npm_proxy: str | None = None,
) -> int:
    if sys.platform == "win32":
        _install_windows_vendored(skip_dvc_pull)
        if tools:
            _install_extra_tools(tools)
    else:
        _install_unix_online(tools, npm_proxy)
    print("Dependencies installed.")
    return 0
