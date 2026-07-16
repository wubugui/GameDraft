"""位面编辑器继承感知护栏（复核 P1-05）。

运行时按 INHERITED_SLOT_KEYS 做槽级继承（PlaneReconciler.expandExtends）；编辑器必须
1. 与运行时清单逐字对齐（parity，防两侧漂移）；
2. 未写槽灰显「沿 extends 链解析的生效值」而非缺省假状态；
3. 能表达三种覆盖原语：显式 membership、显式数值（含 0）、显式空槽 {}；
4. 纯浏览任何形态的位面都不判脏、写回逐键恒等（含显式空槽，旧实现会 pop 丢失）。
"""
from __future__ import annotations

import copy
import re
import sys
import unittest
from pathlib import Path

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.editors.plane_editor import (
    INHERITED_SLOT_KEYS,
    PlaneEditor,
    resolve_effective_slots,
)

_REPO = Path(__file__).resolve().parents[3]

_PLANES = [
    {"id": "normal", "label": "常态"},
    {
        "id": "yin_base",
        "membership": "exclusive",
        "movement": {"driftX": 5, "allowRun": False},
        "interaction": {"canPickup": False},
        "travel": {"allowMapTravel": False},
        "healthDrainPerSec": 5,
        "lighting": {"toneStrength": 0.4},
    },
    {"id": "yin_child", "extends": "yin_base"},
    {"id": "explicit_shared", "extends": "yin_base", "membership": "shared", "movement": {}},
]


class TestInheritedSlotKeysParity(unittest.TestCase):
    def test_editor_matches_runtime_reconciler(self) -> None:
        ts = (_REPO / "src" / "systems" / "PlaneReconciler.ts").read_text(encoding="utf-8")
        m = re.search(
            r"INHERITED_SLOT_KEYS\s*=\s*\[(.*?)\]", ts, re.DOTALL,
        )
        assert m, "PlaneReconciler.ts 里找不到 INHERITED_SLOT_KEYS——若重命名请同步本测试"
        runtime_keys = re.findall(r"'([A-Za-z]+)'", m.group(1))
        self.assertEqual(
            list(INHERITED_SLOT_KEYS), runtime_keys,
            "编辑器与运行时的继承槽清单漂移：两侧必须一致，否则生效值显示/覆盖语义失真",
        )


class TestResolveEffectiveSlots(unittest.TestCase):
    def test_chain_resolution_and_sources(self) -> None:
        eff, src = resolve_effective_slots(_PLANES, "yin_child")
        self.assertEqual(eff["membership"], "exclusive")
        self.assertEqual(src["membership"], "yin_base")
        self.assertEqual(eff["movement"], {"driftX": 5, "allowRun": False})
        self.assertEqual(eff["healthDrainPerSec"], 5)

    def test_own_slot_wins_whole_slot(self) -> None:
        eff, src = resolve_effective_slots(_PLANES, "explicit_shared")
        self.assertEqual(eff["membership"], "shared")
        self.assertEqual(src["membership"], "explicit_shared")
        # 槽级覆盖：写了空 movement 就整槽用自己的，不做键级合并。
        self.assertEqual(eff["movement"], {})
        self.assertEqual(src["movement"], "explicit_shared")

    def test_cycle_breaks_inheritance_like_runtime(self) -> None:
        planes = [
            {"id": "a", "extends": "b", "healthDrainPerSec": 1},
            {"id": "b", "extends": "a", "membership": "exclusive"},
        ]
        eff, _src = resolve_effective_slots(planes, "a")
        self.assertEqual(eff.get("healthDrainPerSec"), 1)
        # 环：b 的槽仍可取到（a→b 一跳后 seen 截断），但不得无限循环——
        # 与运行时 trail 检测口径一致：继承在环点中断。
        self.assertIn("membership", eff)


class TestPlaneEditorInheritanceUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self) -> tuple[ProjectModel, PlaneEditor]:
        m = ProjectModel()
        m.planes = copy.deepcopy(_PLANES)
        return m, PlaneEditor(m)

    def test_pure_browse_never_dirty_and_writeback_identity(self) -> None:
        m, ed = self._editor()
        for i in range(len(m.planes)):
            ed._list.setCurrentRow(i)
            self.assertFalse(ed._is_dirty(), f"第 {i} 行纯浏览即判脏")
            test = copy.deepcopy(m.planes[i])
            ed._write_plane_into(test)
            self.assertEqual(test, m.planes[i], f"第 {i} 行写回漂移")

    def test_child_shows_inherited_effective_values_disabled(self) -> None:
        m, ed = self._editor()
        ed._list.setCurrentRow(2)  # yin_child
        self.assertFalse(ed._f_mv_gate.isChecked())
        self.assertEqual(ed._f_drift_x.value(), 5.0, "未写槽应灰显继承生效值")
        self.assertFalse(ed._f_drift_x.isEnabled())
        self.assertFalse(ed._f_can_pickup.isChecked())
        self.assertFalse(ed._f_allow_map_travel.isChecked())
        self.assertEqual(ed._f_drain.value(), 5.0)
        self.assertFalse(ed._f_drain_chk.isChecked())
        self.assertEqual(ed._f_membership.currentData(), "")
        self.assertTrue(ed._f_inherit_summary.text(), "继承摘要应非空")

    def test_override_primitives_write_expected_json(self) -> None:
        m, ed = self._editor()
        ed._list.setCurrentRow(2)  # yin_child
        ed._f_membership.setCurrentIndex(ed._f_membership.findData("shared"))
        ed._f_drain_chk.setChecked(True)
        ed._f_drain.setValue(0.0)
        ed._f_mv_gate.setChecked(True)
        ed._f_drift_x.setValue(0.0)
        ed._f_allow_run.setChecked(True)
        test = copy.deepcopy(m.planes[2])
        ed._write_plane_into(test)
        self.assertEqual(test.get("membership"), "shared", "显式 shared 覆盖父 exclusive")
        self.assertEqual(test.get("healthDrainPerSec"), 0.0, "显式 0 覆盖父掉血")
        self.assertEqual(test.get("movement"), {}, "空槽 {} = 用缺省整槽覆盖父配置")

    def test_explicit_empty_slot_roundtrips(self) -> None:
        """显式 movement:{}（旧实现 Apply 即 pop 丢失）必须原样往返。"""
        m, ed = self._editor()
        ed._list.setCurrentRow(3)  # explicit_shared
        self.assertTrue(ed._f_mv_gate.isChecked())
        test = copy.deepcopy(m.planes[3])
        ed._write_plane_into(test)
        self.assertEqual(test.get("movement"), {})


if __name__ == "__main__":
    unittest.main()
