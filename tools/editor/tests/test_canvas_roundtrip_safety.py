"""数据零丢失安全网：现有已导出 JSON 的语义往返保证。

这组测试是后续所有画布/数据/保存重构的护栏。任何改动只要让编辑器在
"加载 → 序列化/保存 → 重新加载" 过程中丢失或篡改任何业务数据，这里必红。

注意：断言的是**语义（深层）相等**而非逐字节相等——编辑器的规范格式
（ensure_ascii=False + 2 空格缩进 + 末尾换行 + 不排序键）会把个别历史文件的
紧凑写法/缺失末换行规整化，那是无损的格式归一，不算数据丢失。
"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.file_io import _json_text
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import repo_root_from_tests

# save_all 写盘的全部 dirty 桶（与 ProjectModel.save_all 一致）。
ALL_DIRTY_BUCKETS = [
    "config", "item", "quest", "questGroup", "encounter", "rules", "shop",
    "map", "cutscene", "audio", "strings", "archive", "scene", "flag_registry",
    "overlay_images", "scenarios", "narrative_graphs", "document_reveals",
    "pressure_holds", "signal_cues", "water_minigames", "sugar_wheel",
    "paper_craft", "filter",
]

# 模型内存属性（与 load_project 一致）；保存→重载后逐项深比较。
SNAPSHOT_ATTRS = [
    "game_config", "items", "quests", "quest_groups", "encounters",
    "rules_data", "shops", "map_nodes", "cutscenes", "audio_config", "strings",
    "archive_characters", "archive_lore", "archive_books", "archive_documents",
    "pressure_holds", "signal_cues", "overlay_images", "scenarios_catalog",
    "document_reveals", "scenes", "filter_defs", "flag_registry",
    "water_minigames_index", "water_minigames_instances",
    "sugar_wheel_index", "sugar_wheel_instances",
    "paper_craft_index", "paper_craft_instances",
]


def _deep_clone(obj):
    return json.loads(json.dumps(obj, ensure_ascii=False))


def _model_snapshot(m: ProjectModel) -> dict:
    return {a: _deep_clone(getattr(m, a)) for a in SNAPSHOT_ATTRS}


def _managed_files(m: ProjectModel) -> list[tuple[object, Path]]:
    """(内存对象, 磁盘路径) — 覆盖 save_all 会写出的全部文件。"""
    dp = m.data_path
    sp = m.scenes_path
    pairs: list[tuple[object, Path]] = [
        (m.game_config, dp / "game_config.json"),
        (m.items, dp / "items.json"),
        (m.quests, dp / "quests.json"),
        (m.quest_groups, dp / "questGroups.json"),
        (m.encounters, dp / "encounters.json"),
        (m.rules_data, dp / "rules.json"),
        (m.shops, dp / "shops.json"),
        (m.map_nodes, dp / "map_config.json"),
        (m.cutscenes, dp / "cutscenes" / "index.json"),
        (m.audio_config, dp / "audio_config.json"),
        (m.strings, dp / "strings.json"),
        (m.archive_characters, dp / "archive" / "characters.json"),
        (m.archive_lore, dp / "archive" / "lore.json"),
        (m.archive_books, dp / "archive" / "books.json"),
        (m.archive_documents, dp / "archive" / "documents.json"),
        (m.pressure_holds, dp / "pressure_holds.json"),
        (m.signal_cues, dp / "signal_cues.json"),
        (m.overlay_images, dp / "overlay_images.json"),
        (m.scenarios_catalog, dp / "scenarios.json"),
        (m.document_reveals, dp / "document_reveals.json"),
    ]
    for sid, sc in m.scenes.items():
        pairs.append((sc, sp / f"{sid}.json"))
    for stem, data in m.filter_defs.items():
        pairs.append((data, dp / "filters" / f"{stem}.json"))
    for kind, idx, inst in (
        ("water_minigames", m.water_minigames_index, m.water_minigames_instances),
        ("sugar_wheel", m.sugar_wheel_index, m.sugar_wheel_instances),
        ("paper_craft", m.paper_craft_index, m.paper_craft_instances),
    ):
        pairs.append((idx, dp / kind / "index.json"))
        for row in idx:
            if not isinstance(row, dict):
                continue
            iid = str(row.get("id") or "").strip()
            fid = row.get("file")
            if iid in inst and isinstance(fid, str):
                pairs.append((inst[iid], dp / kind / fid))
    return pairs


class CanvasRoundtripSafetyTests(unittest.TestCase):
    """以真实工程数据为黄金样本，证明加载/序列化/保存对业务数据零篡改。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)
        cls.repo = repo_root_from_tests()
        if not (cls.repo / "public" / "assets" / "data").is_dir():
            raise unittest.SkipTest("真实工程数据不存在，跳过黄金往返测试")

    def test_serialize_roundtrip_loses_no_data(self) -> None:
        """每个受管文件：editor 序列化后重新解析，须与磁盘解析深层相等。"""
        m = ProjectModel()
        m.load_project(self.repo)
        checked = 0
        for obj, path in _managed_files(m):
            if not path.is_file():
                continue
            checked += 1
            disk_obj = json.loads(path.read_text(encoding="utf-8"))
            reparsed = json.loads(_json_text(obj))
            self.assertEqual(
                disk_obj, reparsed,
                msg=f"序列化往返丢失/篡改数据: {path.relative_to(self.repo)}",
            )
        self.assertGreater(checked, 0, "没有检查到任何受管文件")

    def test_save_all_then_reload_is_lossless(self) -> None:
        """整条 save_all 写盘路径：强制全 dirty → 保存 → 重载，逐属性深比较无变化。"""
        with TemporaryDirectory() as td:
            proj = Path(td) / "p"
            shutil.copytree(
                self.repo / "public" / "assets" / "data",
                proj / "public" / "assets" / "data",
            )
            shutil.copytree(
                self.repo / "public" / "assets" / "scenes",
                proj / "public" / "assets" / "scenes",
            )
            m1 = ProjectModel()
            m1.load_project(proj)
            before = _model_snapshot(m1)

            m1._dirty = set(ALL_DIRTY_BUCKETS)
            m1._dirty_scenes_all = True
            m1.save_all()

            m2 = ProjectModel()
            m2.load_project(proj)
            after = _model_snapshot(m2)

            for attr in SNAPSHOT_ATTRS:
                self.assertEqual(
                    before[attr], after[attr],
                    msg=f"save_all → reload 改变了业务数据: {attr}",
                )


if __name__ == "__main__":
    unittest.main()
