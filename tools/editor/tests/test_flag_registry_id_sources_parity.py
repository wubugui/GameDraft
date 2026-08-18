"""ID_SOURCES ↔ build_id_sets 语义级 parity 护栏（editor-tools norms 不变量 8）。

flag_registry_editor.ID_SOURCES 是 pattern idSource 下拉的手工镜像清单，真相源是
flag_registry.build_id_sets 的键集 + ids_for_registry_pattern_source 特判的两个
hotspot 源。曾漂移：build_id_sets 已收 archive_slang / archive_rhyme 而下拉没有——
组合框 editable 掩盖了缺项（策划选不到只能手打）。任一方向漂移即失败并列出差集。
"""
from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[3]

# ids_for_registry_pattern_source 在 build_id_sets 之外特判的两个源
HOTSPOT_SOURCES = {"hotspot_any_scene", "hotspot_in_scene"}


def test_id_sources_matches_build_id_sets_keys() -> None:
    from tools.editor.editors.flag_registry_editor import ID_SOURCES
    from tools.editor.flag_registry import build_id_sets
    from tools.editor.project_model import ProjectModel

    model = ProjectModel()
    model.load_project(REPO)
    authoritative = set(build_id_sets(model)) | HOTSPOT_SOURCES

    missing = sorted(authoritative - set(ID_SOURCES))
    assert not missing, (
        f"build_id_sets 已支持但 ID_SOURCES 下拉缺失（策划选不到，只能手打）：{missing}"
    )
    dead = sorted(set(ID_SOURCES) - authoritative)
    assert not dead, (
        f"ID_SOURCES 下拉存在 build_id_sets 不认的源（展开必为空，静默不匹配任何 id）：{dead}"
    )
