"""新建 / 删除 / 复制的验收。

这一族对应老画布两类真实事故：

1. **`len(列表)` 编号必撞名** —— 删了中间项之后 `len` 回落到已被占用的数字，
   新建的实体把别人覆盖掉。
2. **删除撤销后实体跑到末尾** —— JSON 数组序是运行时平局排序的依据，
   撤销一次前后关系就悄悄变了，属于"撤销没撤干净"的隐蔽形态。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtCore import QPointF
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.tools_structure import (
    create_entity_at,
    delete_selected,
    duplicate_selected,
    unique_entity_id,
)


class _FakeModel:
    def __init__(self, scene: dict) -> None:
        self.scenes = {"街": scene}
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str) -> None:
        self.dirty.append((domain, key))


def _scene() -> dict:
    return {
        "id": "街", "name": "街", "worldWidth": 800, "worldHeight": 600,
        "hotspots": [
            {"id": "a", "type": "inspect", "x": 10, "y": 10},
            {"id": "b", "type": "inspect", "x": 20, "y": 20, "unknownKey": {"k": 1}},
            {"id": "c", "type": "inspect", "x": 30, "y": 30},
        ],
        "npcs": [],
        "zones": [],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, "街")

    def tearDown(self) -> None:
        self.doc.deleteLater()
        QApplication.processEvents()

    def ids(self, key: str = "hotspots") -> list[str]:
        return [e["id"] for e in self.doc.scene()[key]]


class UniqueIdTests(_Base):
    def test_free_name_is_used_as_is(self) -> None:
        self.assertEqual(unique_entity_id(self.doc, "hotspot", "door"), "door")

    def test_taken_name_gets_a_suffix(self) -> None:
        self.assertEqual(unique_entity_id(self.doc, "hotspot", "a"), "a_2")

    def test_never_reuses_a_taken_id_after_a_middle_delete(self) -> None:
        """`len(列表)` 编号的经典死法：删中间项后新建必撞名。"""
        sc = self.doc.scene()
        sc["hotspots"] = [e for e in sc["hotspots"] if e["id"] != "b"]
        new_id = unique_entity_id(self.doc, "hotspot", "a")
        self.assertNotIn(new_id, {"a", "c"})

    def test_counts_on_from_an_existing_suffix(self) -> None:
        sc = self.doc.scene()
        sc["hotspots"].append({"id": "a_2", "type": "inspect", "x": 0, "y": 0})
        self.assertEqual(unique_entity_id(self.doc, "hotspot", "a_2"), "a_3")


class CreateTests(_Base):
    def test_create_adds_and_selects(self) -> None:
        self.assertTrue(create_entity_at(self.doc, "hotspot", QPointF(200, 300)))
        self.assertEqual(len(self.ids()), 4)
        self.assertEqual(len(self.doc.selection), 1)
        ent = self.doc.model_entity(self.doc.selection[0])
        self.assertEqual((ent["x"], ent["y"]), (200.0, 300.0))

    def test_create_is_undoable(self) -> None:
        create_entity_at(self.doc, "hotspot", QPointF(200, 300))
        self.doc.undo_stack.undo()
        self.assertEqual(self.ids(), ["a", "b", "c"])

    def test_zone_gets_a_polygon_and_no_xy(self) -> None:
        self.assertTrue(create_entity_at(self.doc, "zone", QPointF(100, 100)))
        z = self.doc.scene()["zones"][0]
        self.assertEqual(len(z["polygon"]), 4)
        self.assertNotIn("x", z, "Zone 不该有 x/y —— 它的几何是 polygon")

    def test_unknown_kind_is_refused(self) -> None:
        self.assertFalse(create_entity_at(self.doc, "nope", QPointF(0, 0)))


class DeleteTests(_Base):
    def test_delete_removes_selected(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "b")])
        self.assertTrue(delete_selected(self.doc))
        self.assertEqual(self.ids(), ["a", "c"])

    def test_undo_restores_at_the_original_index(self) -> None:
        """**必须回到原下标** —— 放到末尾会改 JSON 数组序，前后关系跟着变。"""
        self.doc.set_selection([EntityRef("hotspot", "b")])
        delete_selected(self.doc)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ids(), ["a", "b", "c"], "撤销后实体跑到了别的位置")

    def test_undo_restores_unknown_keys(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "b")])
        delete_selected(self.doc)
        self.doc.undo_stack.undo()
        restored = self.doc.model_entity(EntityRef("hotspot", "b"))
        self.assertEqual(restored.get("unknownKey"), {"k": 1},
                         "未受管字段在删除往返里丢了")

    def test_multi_delete_is_one_command(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "a"), EntityRef("hotspot", "c")])
        delete_selected(self.doc)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ids(), ["a", "b", "c"])

    def test_delete_clears_them_from_selection(self) -> None:
        ref = EntityRef("hotspot", "b")
        self.doc.set_selection([ref])
        delete_selected(self.doc)
        self.assertNotIn(ref, self.doc.selection)

    def test_delete_with_empty_selection_is_a_noop(self) -> None:
        self.assertFalse(delete_selected(self.doc))
        self.assertEqual(self.doc.undo_stack.count(), 0)


class DuplicateTests(_Base):
    def test_duplicate_creates_a_copy_with_a_free_id(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "a")])
        self.assertTrue(duplicate_selected(self.doc))
        self.assertEqual(len(self.ids()), 4)
        self.assertEqual(len(set(self.ids())), 4, "复制出来的 id 撞名了")

    def test_copy_is_offset_so_it_is_visible(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "a")])
        duplicate_selected(self.doc)
        new_ent = self.doc.model_entity(self.doc.selection[0])
        self.assertNotEqual((new_ent["x"], new_ent["y"]), (10, 10))

    def test_selection_moves_to_the_copies(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "a")])
        duplicate_selected(self.doc)
        self.assertEqual(len(self.doc.selection), 1)
        self.assertNotEqual(self.doc.selection[0].id, "a")

    def test_duplicating_many_at_once_does_not_self_collide(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "a"), EntityRef("hotspot", "b")])
        duplicate_selected(self.doc)
        self.assertEqual(len(set(self.ids())), 5, "同一批复制出来的副本互相撞名了")

    def test_duplicate_is_one_undoable_command(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "a"), EntityRef("hotspot", "b")])
        duplicate_selected(self.doc)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ids(), ["a", "b", "c"])

    def test_unknown_keys_are_carried_into_the_copy(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "b")])
        duplicate_selected(self.doc)
        clone = self.doc.model_entity(self.doc.selection[0])
        self.assertEqual(clone.get("unknownKey"), {"k": 1})

    def test_zone_polygon_is_offset_too(self) -> None:
        create_entity_at(self.doc, "zone", QPointF(100, 100))
        original = list(self.doc.scene()["zones"][0]["polygon"])
        duplicate_selected(self.doc)
        clone_poly = self.doc.scene()["zones"][1]["polygon"]
        self.assertNotEqual(clone_poly[0]["x"], original[0]["x"],
                            "Zone 副本与原件完全重叠，看着像什么都没发生")


if __name__ == "__main__":
    unittest.main()
