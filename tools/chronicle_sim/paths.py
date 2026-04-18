"""工程内路径：包根、项目根、runs 目录。"""
from __future__ import annotations

from pathlib import Path

PACKAGE_ROOT: Path = Path(__file__).resolve().parent
TOOLS_ROOT: Path = PACKAGE_ROOT.parent
PROJECT_ROOT: Path = TOOLS_ROOT.parent
DATA_DIR: Path = PACKAGE_ROOT / "data"
RUNS_DIR: Path = PACKAGE_ROOT / "runs"
SEED_MD_LIBRARY_ROOT: Path = DATA_DIR / "seed_md_library"
SEED_MD_FILES_DIR: Path = SEED_MD_LIBRARY_ROOT / "files"
SEED_MD_MANIFEST_PATH: Path = SEED_MD_LIBRARY_ROOT / "manifest.json"


def ensure_runs_dir() -> Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    return RUNS_DIR


def ensure_seed_md_library_dirs() -> Path:
    SEED_MD_FILES_DIR.mkdir(parents=True, exist_ok=True)
    return SEED_MD_LIBRARY_ROOT
