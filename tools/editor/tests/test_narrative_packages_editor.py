"""章节导演清单编辑器（NarrativePackagesEditor）契约测试。

覆盖：真实工程数据加载后往返保真（load→无编辑→flush 零伪脏）、
autoPlay runActions 展开/打包往返、新增/删除写回、silent flush 不弹框不丢数据。
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
        # 用真实工程（含 narrative_packages.json 的听书/梦境行 + 真实 scene id）
        m = ProjectModel()
        m.load_project(Path(__file__).resolve().parents[3])
        return m

    def test_loads_real_rows(self) -> None:
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            ids = [str(r.get("id")) for r in ed._rows]
            self.assertIn("听书开场", ids)
            self.assertIn("梦_夜路开场", ids)
        finally:
            ed.deleteLater()

    def test_no_edit_no_pseudo_dirty(self) -> None:
        m = self._model()
        marks: list[str] = []
        orig = m.mark_dirty
        m.mark_dirty = lambda dt, item="": marks.append(dt)  # type: ignore
        ed = NarrativePackagesEditor(m)
        try:
            # 载入即选中首行，未做任何编辑 → flush 必须零 mark_dirty
            ed.flush_to_model()
            self.assertEqual(marks, [], f"零编辑却标脏：{marks}")
        finally:
            m.mark_dirty = orig  # type: ignore
            ed.deleteLater()

    def test_roundtrip_preserves_teahouse_row(self) -> None:
        m = self._model()
        before = next(r for r in (m.narrative_packages.get("packages") or []) if r.get("id") == "听书开场")
        ed = NarrativePackagesEditor(m)
        try:
            idx = [r.get("id") for r in ed._rows].index("听书开场")
            ed._list.setCurrentRow(idx)
            # 触发一次应用（模拟用户点「应用」），往返应保真
            ed._dirty = True
            self.assertTrue(ed._apply(silent=True))
            after = next(r for r in ed._rows if r.get("id") == "听书开场")
            self.assertEqual(after.get("scene"), before.get("scene"))
            self.assertEqual(after.get("done"), before.get("done"))
            self.assertEqual(after.get("autoPlay"), before.get("autoPlay"))
        finally:
            ed.deleteLater()

    def test_dream_runactions_roundtrip(self) -> None:
        """梦境行 autoPlay=runActions：编辑器展开成多条动作，保存时打包回 runActions，内容保真。"""
        m = self._model()
        before = next(r for r in (m.narrative_packages.get("packages") or []) if r.get("id") == "梦_醒来土路开场")
        ed = NarrativePackagesEditor(m)
        try:
            idx = [r.get("id") for r in ed._rows].index("梦_醒来土路开场")
            ed._list.setCurrentRow(idx)
            ed._dirty = True
            self.assertTrue(ed._apply(silent=True))
            after = next(r for r in ed._rows if r.get("id") == "梦_醒来土路开场")
            self.assertEqual(after.get("autoPlay"), before.get("autoPlay"))
        finally:
            ed.deleteLater()

    def test_add_and_delete(self) -> None:
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            n0 = len(ed._rows)
            ed._add()
            self.assertEqual(len(ed._rows), n0 + 1)
            self.assertTrue(ed._rows[-1]["id"].startswith("新戏"))
            # 删除刚加的（跳过确认弹窗）
            ed._current = len(ed._rows) - 1
            del ed._rows[ed._current]
            ed._commit_to_model()
            self.assertEqual(len(ed._rows), n0)
        finally:
            ed.deleteLater()

    def test_silent_flush_incomplete_row_no_crash(self) -> None:
        """新增只填 id 的不完整行，silent flush 不弹框、不抛异常（保留行待补全）。"""
        m = self._model()
        ed = NarrativePackagesEditor(m)
        try:
            ed._add()  # 新戏：只有 id，无 scene/package
            ed._dirty = True
            # 不应弹框、不抛异常
            ed.flush_to_model()
        finally:
            ed.deleteLater()


if __name__ == "__main__":
    unittest.main()
