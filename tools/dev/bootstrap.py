"""Project bootstrap actions for macOS/Linux."""

from __future__ import annotations

import shutil
from pathlib import Path

from tools.dev import creds
from tools.dev.paths import project_python, project_python_ready, repo_root

#: clean 要删掉的本地产物。**四个 DVC 工作区目录必须全在这里**:
#: 少一个就会留下"目录还在、`.dvc/cache` 已被删空"的半残状态,
#: 下一次 push 展开该目标的缓存清单时会炸(见 sync.target_is_in_local_cache)。
#: 由 tools/dev/tests/test_bootstrap.py 对着 sync.COMMIT_DVC_ADD_PATHS 锁住。
CLEAN_PATHS = [
    ".tools",
    "node_modules",
    ".cache",
    ".dvc/cache",
    "dist",
    "public/resources/runtime",
    "resources/editor_projects",
    "resources/vendor_archives",
    "resources/audio_sources",
]


def ensure_local_python() -> Path:
    """Return the project Python created by ``bootstrap.sh``."""
    if not project_python_ready():
        raise SystemExit("Project venv missing (.tools/venv). Run ./bootstrap.sh first.")
    print("Local Python runtime: ready")
    return project_python()


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
    """编辑器初始化:运行时 + 编辑器工程,**不含配音音源**。

    工作台虽然挂在主编辑器菜单上,但源库缺席时它如实报「源不在本机」而非坏掉,
    所以 70MB 素材不进这条通用初始化路径。要它:`./dev.sh init-audio`
    (或 `./dev.sh pull --audio`)。
    """
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
    print("Will remove: " + ", ".join(CLEAN_PATHS))
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
