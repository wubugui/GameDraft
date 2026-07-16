"""脏桶键名 parity + save_all 两阶段原子性护栏（复核 P1-02 / P1-03）。

历史 bug：mark_dirty("quests")（应为 "quest"）→ Save All 不写文件却清脏标记，
暂存内容无声丢失。护栏三件：
1. 全源码 mark_dirty("…") 字面量 ⊆ ProjectModel.KNOWN_DIRTY_BUCKETS；
2. KNOWN_DIRTY_BUCKETS 与 save_all 写盘分支（`if "x" in dty`）一一对应；
3. mark_dirty 收到未登记键直接 raise（不再无声吞）。
另：save_all 两阶段写——任一桶序列化失败时，磁盘上任何目标文件都不得已被改写。
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    file_sha256,
    write_minimal_loadable_project,
)

_REPO = Path(__file__).resolve().parents[3]
_TOOL_DIRS = (
    _REPO / "tools" / "editor",
    _REPO / "tools" / "dialogue_graph_editor",
)


def _iter_source_files():
    for base in _TOOL_DIRS:
        for p in base.rglob("*.py"):
            if "tests" in p.parts or "__pycache__" in p.parts:
                continue
            yield p


class TestDirtyBucketParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_all_mark_dirty_literals_are_known_buckets(self) -> None:
        pat = re.compile(r'mark_dirty\(\s*"([^"]+)"')
        offenders: list[str] = []
        for p in _iter_source_files():
            for mline, m in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                for hit in pat.findall(m):
                    if hit not in ProjectModel.KNOWN_DIRTY_BUCKETS:
                        offenders.append(f"{p.relative_to(_REPO)}:{mline}: {hit!r}")
        self.assertEqual(
            offenders, [],
            "存在未登记的 mark_dirty 桶名（save_all 不写文件却清脏标记，数据无声丢失）：\n"
            + "\n".join(offenders),
        )

    def test_known_buckets_match_save_all_branches(self) -> None:
        src = (_REPO / "tools" / "editor" / "project_model.py").read_text(encoding="utf-8")
        handled = set(re.findall(r'if "([a-zA-Z_]+)" in dty', src))
        self.assertEqual(
            set(ProjectModel.KNOWN_DIRTY_BUCKETS), handled,
            "KNOWN_DIRTY_BUCKETS 与 save_all 写盘分支不一致——两处必须同步维护",
        )

    def test_mark_dirty_rejects_unknown_bucket(self) -> None:
        m = ProjectModel()
        with self.assertRaises(ValueError):
            m.mark_dirty("quests")  # 历史 bug 的原始拼写，必须被当场拦下


class TestStagedSaveAtomicity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_serialize_failure_leaves_all_files_untouched(self) -> None:
        """config+item 双桶脏、item 序列化失败：config 文件也不得被改写（两阶段写）。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            dp = root / "public" / "assets" / "data"
            cfg_before = file_sha256(dp / "game_config.json")
            items_before = file_sha256(dp / "items.json")

            m.game_config["_probe"] = 1
            m.items.append({"id": "bad", "payload": {1, 2, 3}})  # set 不可 JSON 序列化
            m.mark_dirty("config")
            m.mark_dirty("item")
            with self.assertRaises(TypeError):
                m.save_all()

            self.assertEqual(file_sha256(dp / "game_config.json"), cfg_before,
                             "任一桶失败时，其它桶也不得已落盘（半保存）")
            self.assertEqual(file_sha256(dp / "items.json"), items_before)
            self.assertTrue(m.is_dirty, "失败后 dirty 必须保留，修好可重存")
            stray = [p.name for p in dp.rglob("*.tmp")]
            self.assertEqual(stray, [], f"失败路径必须清理暂存 .tmp：{stray}")


if __name__ == "__main__":
    unittest.main()
