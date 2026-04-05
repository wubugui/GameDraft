"""滤镜 JSON 目录与仓库根路径（供 filter_tool 与 editor 共用）。"""
from __future__ import annotations

from pathlib import Path


def project_root_from_filter_package() -> Path:
    """本文件位于 tools/filter_tool/paths.py，向上两级为 GameDraft 仓库根。"""
    return Path(__file__).resolve().parent.parent.parent


def filters_json_dir(project_root: Path) -> Path:
    """与游戏、滤镜工具写入位置一致：public/assets/data/filters。"""
    return project_root / "public" / "assets" / "data" / "filters"
