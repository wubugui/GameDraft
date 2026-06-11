"""Platform bootstrap, ported from scripts/bootstrap.ps1 + bootstrap-dvc.ps1.

Windows acquires the vendored portable Python (.tools/Python311) via OSS
download when missing; unix relies on .tools/venv created by bootstrap.sh.
Both share the game/editor/clean menu actions.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

from tools.dev import creds, proxyenv
from tools.dev.paths import (
    project_python,
    project_python_ready,
    repo_root,
    windows_python,
)

BOOTSTRAP_ARCHIVE_NAME = "python311-dvc-win-x64.zip"

# Mirrors scripts/bootstrap.ps1 Clean-LocalEnvironment $Paths (posix separators).
CLEAN_PATHS = [
    ".tools",
    "node_modules",
    ".cache",
    ".dvc/cache",
    "dist",
    "public/resources/runtime",
    "resources/editor_projects",
    "resources/vendor_archives",
]


def _bootstrap_base_url() -> str | None:
    url = os.environ.get("GAMEDRAFT_BOOTSTRAP_BASE_URL", "").strip()
    if url:
        return url
    for name in ("bootstrap-oss.json", "bootstrap-oss.example.json"):
        path = repo_root() / "config" / name
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            base = str(data.get("baseUrl", "")).strip()
            if base:
                return base
    return None


def _download_portable_python(archive_dest: Path) -> None:
    """Fetch python311-dvc-win-x64.zip from OSS (signed if creds present)."""
    from tools.dev import oss_http

    base_url = _bootstrap_base_url()
    if not base_url:
        raise SystemExit(
            "Missing bootstrap OSS URL. Ensure config/bootstrap-oss.example.json "
            "exists with baseUrl, copy it to config/bootstrap-oss.json for "
            "overrides, or set GAMEDRAFT_BOOTSTRAP_BASE_URL."
        )
    url = base_url.rstrip("/") + "/" + BOOTSTRAP_ARCHIVE_NAME
    kid, ks = creds.hydrate_credentials()
    with proxyenv.without_proxy():
        if kid and ks:
            print(f"Downloading DVC portable runtime — OSS RAM signed GET — from {url}")
            oss_http.download_signed(url, archive_dest, kid, ks)
        else:
            print(f"Downloading DVC portable runtime — anonymous HTTP GET — from {url}")
            print(
                "No OSS keys in this process: private buckets return 403 on "
                "anonymous GET. Run bootstrap game/editor first so keys are set."
            )
            oss_http.download_direct(url, archive_dest)


def ensure_local_python() -> Path:
    """Return the project Python, acquiring the Windows portable build if needed."""
    if sys.platform != "win32":
        if not project_python_ready():
            raise SystemExit(
                "Project venv missing (.tools/venv). Run ./bootstrap.sh first."
            )
        print("Local Python runtime: ready")
        return project_python()

    python_exe = windows_python()
    if python_exe.is_file():
        print("Local Python runtime: ready")
        return python_exe

    print("Local Python runtime: missing, downloading bootstrap runtime...")
    tools_dir = repo_root() / ".tools"
    tools_dir.mkdir(parents=True, exist_ok=True)

    vendor_archive = repo_root() / "resources" / "vendor_archives" / BOOTSTRAP_ARCHIVE_NAME
    if vendor_archive.is_file():
        archive = vendor_archive
    else:
        cache_dir = repo_root() / ".cache" / "bootstrap"
        cache_dir.mkdir(parents=True, exist_ok=True)
        archive = cache_dir / BOOTSTRAP_ARCHIVE_NAME
        _download_portable_python(archive)

    print(f"Extracting {BOOTSTRAP_ARCHIVE_NAME}")
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(tools_dir)
    if not python_exe.is_file():
        raise SystemExit("DVC portable runtime did not extract to .tools/Python311.")
    return python_exe


def _initialize(targets: list[str]) -> None:
    from tools.dev import deps, sync

    creds.ensure_credentials(prompt=True)
    ensure_local_python()
    deps.install_deps()
    for target in targets:
        print(f"Syncing {target} ...")
        sync.pull_dvc_target(target)


def initialize_game() -> int:
    _initialize([sync_runtime_target()])
    print("Game initialization complete.")
    return 0


def initialize_editor() -> int:
    _initialize([sync_runtime_target(), sync_editor_target()])
    print("Editor initialization complete.")
    return 0


def sync_runtime_target() -> str:
    from tools.dev import sync

    return sync.RUNTIME_TARGET


def sync_editor_target() -> str:
    from tools.dev import sync

    return sync.EDITOR_TARGET


def _remove_repo_path(relative: str) -> None:
    root = repo_root().resolve()
    target = (root / relative).resolve()
    if not target.exists():
        return
    if root not in target.parents and target != root:
        raise SystemExit(f"Refusing to clean path outside repo: {target}")
    print(f"Removing {relative}")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


def clean_local_environment(assume_yes: bool = False) -> int:
    print("Clean removes local fetched resources, dependency installs, build output, and DVC cache.")
    print("It does not remove Git-tracked code or your saved OSS credentials.")
    if not assume_yes:
        if input("Type CLEAN to continue: ").strip() != "CLEAN":
            print("Clean cancelled.")
            return 0
    for path in CLEAN_PATHS:
        _remove_repo_path(path)
    print("Clean complete.")
    return 0


def run(action: str = "", assume_yes: bool = False) -> int:
    if action == "game":
        return initialize_game()
    if action == "editor":
        return initialize_editor()
    if action == "clean":
        return clean_local_environment(assume_yes=assume_yes)
    if action:
        raise SystemExit(f"Unknown bootstrap action: {action}")
    return _interactive_menu()


def _interactive_menu() -> int:
    while True:
        print("\nGameDraft Bootstrap")
        print("1. Initialize game")
        print("2. Initialize editor")
        print("3. Clean local environment")
        print("0. Exit")
        choice = input("Select: ").strip()
        if choice == "1":
            initialize_game()
        elif choice == "2":
            initialize_editor()
        elif choice == "3":
            clean_local_environment()
        elif choice == "0":
            return 0
        else:
            print("Unknown selection.")
