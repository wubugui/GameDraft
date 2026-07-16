"""LSP overlay 镜像 parity 护栏(审查 P1-15)。

「运行时写盘分支 ↔ overlay 镜像」是第三张手工镜像清单;曾漏登记 characterRegistry,
导致未保存的角色编辑对全局搜索/查引用静默失真(对话框却明示"实时含未保存编辑")。

护栏:ProjectModel.KNOWN_DIRTY_BUCKETS 里每个单文件内容桶,要么在 overlay 镜像表
(overlay_mirrored_buckets),要么在显式豁免清单(OVERLAY_EXEMPT_BUCKETS)——两表并集
必须精确等于 KNOWN_DIRTY_BUCKETS,防第三处漂移。
另:characterRegistry overlay 形状必须与 save_all 写盘分支同形。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.lsp_client import (
    OVERLAY_EXEMPT_BUCKETS,
    overlay_mirrored_buckets,
    overlay_payloads,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class TestOverlayBucketParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_every_dirty_bucket_is_mirrored_or_explicitly_exempt(self) -> None:
        mirrored = overlay_mirrored_buckets()
        covered = set(mirrored) | set(OVERLAY_EXEMPT_BUCKETS)
        known = set(ProjectModel.KNOWN_DIRTY_BUCKETS)
        missing = known - covered
        self.assertEqual(
            missing, set(),
            "这些脏桶既未镜像成 overlay 也未显式豁免——未保存编辑对搜索/查引用会静默失真。"
            "补进 _SIMPLE_OVERLAY_FILES / OVERLAY_SPECIAL_BUCKETS 或 OVERLAY_EXEMPT_BUCKETS：\n"
            + "\n".join(sorted(missing)),
        )
        stray = covered - known
        self.assertEqual(
            stray, set(),
            "overlay 镜像/豁免表出现了 KNOWN_DIRTY_BUCKETS 里没有的桶(已过时):\n"
            + "\n".join(sorted(stray)),
        )

    def test_mirror_and_exempt_are_disjoint(self) -> None:
        overlap = set(overlay_mirrored_buckets()) & set(OVERLAY_EXEMPT_BUCKETS)
        self.assertEqual(overlap, set(),
                         f"同一桶不能既镜像又豁免:{sorted(overlap)}")

    def test_character_registry_is_mirrored(self) -> None:
        # 本条即 P1-15 的漂移实证:characterRegistry 曾漏登记
        self.assertIn("characterRegistry", overlay_mirrored_buckets())

    def test_character_registry_overlay_shape_matches_save_all(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            # H 组修复：旧 fixture 按 c1、c2 顺序插入（本就与 sorted 同序），改成 sorted 仍 PASS，
            # 是假承诺——区分不出"插入序"和"sorted"。这里故意逆序插入（zwang 先、awang 后），
            # 使插入序 [zwang, awang] ≠ sorted [awang, zwang]，真能咬住"是否被 sorted"。
            m.character_registry["zwang"] = {"id": "zwang", "name": "老王"}
            m.character_registry["awang"] = {"id": "awang", "name": "老李"}
            out = overlay_payloads(m, "characterRegistry")
            self.assertEqual(len(out), 1)
            path, data = out[0]
            self.assertEqual(path.name, "character_registry.json")
            # 形状与 save_all 写盘分支一致:{"characters": [...]}（**插入序**，非 sorted）。
            # 若 overlay/save_all 退化成按 id 排序，此断言会 FAIL（sorted 会得 [awang, zwang]）。
            self.assertEqual(
                data, {"characters": [{"id": "zwang", "name": "老王"},
                                      {"id": "awang", "name": "老李"}]},
            )


if __name__ == "__main__":
    unittest.main()
