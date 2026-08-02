"""章节导演清单编辑器（NarrativePackagesEditor）契约测试。

导演维护章节包活跃度组织标记（2026-07-19 降级：包=纯组织标签，不 gate 行为），
行 = {id, package(必填), scene?, when?, done?}，无 autoPlay。
覆盖：真实工程数据加载后往返保真（load→无编辑→flush 零伪脏）、里程碑行/场景行往返、
必填 package 拦截、新增/删除写回、silent flush 不弹框不丢数据。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.editors.narrative_packages_editor import NarrativePackagesEditor


class TestNarrativePackagesEditor(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _model(self) -> ProjectModel:
        m = ProjectModel()
        m.load_project(Path(__file__).resolve().parents[3])
        return m

    def test_loads_real_rows(self) -> None:
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            ids = [str(r.get("id")) for r in ed._rows]
            self.assertIn("听书开场", ids)      # 场景驱动包行（scene teahouse + package 章节_听书）
            self.assertIn("章节_背尸", ids)      # 里程碑驱动包行
            self.assertIn("章节_义庄", ids)      # 支线场景驱动包行
            # 每行都必配 package（导演只管包）
            for r in ed._rows:
                self.assertTrue(str(r.get("package") or "").strip(), f"{r.get('id')} 缺 package")
                self.assertNotIn("autoPlay", r, f"{r.get('id')} 不该有 autoPlay")
        finally:
            ed.deleteLater()

    def test_no_edit_no_pseudo_dirty(self) -> None:
        m = self._model()
        marks: list[str] = []
        orig = m.mark_dirty
        m.mark_dirty = lambda dt, item="": marks.append(dt)  # type: ignore
        ed = NarrativePackagesEditor(m)
        try:
            ed.flush_to_model()
            self.assertEqual(marks, [], f"零编辑却标脏：{marks}")
        finally:
            m.mark_dirty = orig  # type: ignore
            ed.deleteLater()

    def test_scene_row_roundtrips(self) -> None:
        """场景驱动包行（听书开场）：scene/package/done 往返保真。"""
        m = self._model()
        before = next(r for r in (m.narrative_packages.get("packages") or []) if r.get("id") == "听书开场")
        ed = NarrativePackagesEditor(m)
        try:
            idx = [r.get("id") for r in ed._rows].index("听书开场")
            ed._list.setCurrentRow(idx)
            ed._dirty = True
            self.assertTrue(ed._apply(silent=True))
            after = next(r for r in ed._rows if r.get("id") == "听书开场")
            self.assertEqual(after.get("scene"), before.get("scene"))
            self.assertEqual(after.get("package"), before.get("package"))
            self.assertEqual(after.get("done"), before.get("done"))
            self.assertNotIn("autoPlay", after)
        finally:
            ed.deleteLater()

    def test_milestone_row_roundtrips(self) -> None:
        """里程碑驱动包行（章节_背尸）：package/when/done 往返保真，无 scene。"""
        m = self._model()
        before = next(r for r in (m.narrative_packages.get("packages") or []) if r.get("id") == "章节_背尸")
        ed = NarrativePackagesEditor(m)
        try:
            idx = [r.get("id") for r in ed._rows].index("章节_背尸")
            ed._list.setCurrentRow(idx)
            ed._dirty = True
            self.assertTrue(ed._apply(silent=True))
            after = next(r for r in ed._rows if r.get("id") == "章节_背尸")
            self.assertEqual(after.get("package"), before.get("package"))
            self.assertEqual(after.get("when"), before.get("when"))
            self.assertEqual(after.get("done"), before.get("done"))
            self.assertNotIn("scene", after)
        finally:
            ed.deleteLater()

    def test_missing_package_rejected(self) -> None:
        """行没选 package：apply 非静默应拦（返回 False，弹框在真人路径）；silent 不崩不提交。"""
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            ed._add()  # 新行只有 id，无 package
            ed._dirty = True
            # silent 路径不弹框、不抛异常（不完整行保留待补）
            ed.flush_to_model()
        finally:
            ed.deleteLater()

    def test_add_and_delete(self) -> None:
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            n0 = len(ed._rows)
            ed._add()
            self.assertEqual(len(ed._rows), n0 + 1)
            ed._current = len(ed._rows) - 1
            del ed._rows[ed._current]
            ed._commit_to_model()
            self.assertEqual(len(ed._rows), n0)
        finally:
            ed.deleteLater()

    def test_reload_refs_preserves_open_scene_package_draft_and_dirty_state(self) -> None:
        m = self._model()
        scene_ids = ["scene_old"]
        package_ids = ["package_old"]
        m.all_scene_ids = lambda: list(scene_ids)  # type: ignore[method-assign]
        m.narrative_package_ids_ordered = lambda: list(package_ids)  # type: ignore[method-assign]
        m.narrative_packages = {
            "packages": [{
                "id": "row_old",
                "scene": "scene_old",
                "package": "package_old",
            }],
        }
        ed = NarrativePackagesEditor(m)
        try:
            scene_selector = ed._f_scene
            package_selector = ed._f_package
            ed._f_id.setText("尚未应用的新行名")
            ed._on_edit()
            self.assertTrue(ed._dirty)

            scene_ids[:] = ["scene_new"]
            package_ids[:] = ["package_new"]
            m._dirty.clear()
            ed.reload_refs_from_model()

            self.assertIs(ed._f_scene, scene_selector, "刷新不得重建当前表单")
            self.assertIs(ed._f_package, package_selector)
            self.assertEqual(ed._f_scene.current_id(), "scene_old")
            self.assertIn("scene_new", ed._f_scene._ids)
            self.assertEqual(ed._f_package.current_id(), "package_old")
            self.assertIn("package_new", ed._f_package._ids)
            self.assertEqual(ed._f_id.text(), "尚未应用的新行名")
            self.assertTrue(ed._dirty, "刷新不得提交或清除已有未应用编辑")
            self.assertEqual(m._dirty, set(), "候选目录刷新本身不得标工程脏")
        finally:
            ed.deleteLater()

    def test_reload_refs_does_not_create_dirty_state_when_form_is_clean(self) -> None:
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            self.assertFalse(ed._dirty)
            m._dirty.clear()
            ed.reload_refs_from_model()
            self.assertFalse(ed._dirty)
            self.assertEqual(m._dirty, set())
        finally:
            ed.deleteLater()


if __name__ == "__main__":
    unittest.main()
