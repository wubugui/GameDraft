"""点火接触帧（`sockets.json.igniteSlots`，燃烧系统 A3.8）的读写规则与面板流程。

与落脚帧 `contactSlots` 完全同口径（按槽位、同一份指纹、同一个挂点面板里勾）。钉死：
- 清洗口径与 TS 侧 `parseContactSlots` 逐值一致（`animationSockets.ts` 对 igniteSlots 也走它）；
- 往返：磁盘上没有 igniteSlots 的文件打开→不动→保存逐字节不变、不长键；有键保值；
- 只标了点火接触帧、一个挂点 / 落脚帧都没有的文件必须保留；三样都没了才删；
- 面板：从「本帧点火接触」勾选框入口勾 / 取消 → 置脏并进 AnimEditor 门 → 保存产物正确；
  帧条 / 画布带与落脚帧可区分的标记；Discard 回滚；
- stale：勾选框启用规则与落脚帧一致（不因 stale 另开一套），重标保存才刷新指纹；
- 播放预览信息行只在运行时真正取的那一帧（片段里第一个标了的帧）标「点火接触帧」。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.editors.anim_editor import AnimEditor  # noqa: E402
from tools.editor.file_io import write_json  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.animation_sockets import (  # noqa: E402
    CONTACT_SLOTS_KEY,
    IGNITE_SLOTS_KEY,
    empty_socket_set,
    ignite_slots_of,
    load_socket_set,
    normalize_contact_slots,
    normalize_ignite_slots,
    sanitize_socket_set,
    save_socket_set,
    set_contact_slot,
    set_ignite_slot,
    sockets_path_for_bundle,
)
from tools.editor.tests.save_test_utils import repo_root_from_tests  # noqa: E402

_ANIM: dict[str, Any] = {
    "cols": 9, "rows": 10,
    "atlasFrames": [{"width": 1, "height": 1} for _ in range(89)],
    "states": {"ignite": {"frames": list(range(30, 40)), "frameRate": 8}},
}


# ---------------------------------------------------------------- 清洗口径

class NormalizeTests(unittest.TestCase):
    def test_parity_with_ts_parse_contact_slots(self) -> None:
        """与 `src/data/animationSockets.test.ts` parseContactSlots 用例同一组输入、同一个答案。"""
        raw = [20, 12, 12, -1, 2.5, "30", 999, 38]
        self.assertEqual(normalize_ignite_slots(raw, 89), [12, 20, 38])

    def test_same_answer_as_contact_slots_on_garbage(self) -> None:
        cases = [
            [True, 3, False], [12.0, 20.0], [88, 89, 0], [None, {}, [], 5],
            None, "12", {"0": 1}, 12, [],
        ]
        for raw in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_ignite_slots(raw, 89), normalize_contact_slots(raw, 89))

    def test_bool_negative_out_of_range_duplicate_dropped_sorted(self) -> None:
        self.assertEqual(normalize_ignite_slots([True, 7, -2, 89, 7, 3, 1.5], 89), [3, 7])

    def test_no_upper_bound_when_slot_count_unknown(self) -> None:
        self.assertEqual(normalize_ignite_slots([999, 3], 0), [3, 999])

    def test_ignite_slots_of_tolerates_garbage(self) -> None:
        self.assertEqual(ignite_slots_of(None), [])
        self.assertEqual(ignite_slots_of({IGNITE_SLOTS_KEY: "x"}), [])
        self.assertEqual(ignite_slots_of({IGNITE_SLOTS_KEY: [5, 1, 1]}), [1, 5])


class SetIgniteSlotTests(unittest.TestCase):
    def test_toggle_on_off_and_key_removed_when_empty(self) -> None:
        data = empty_socket_set(_ANIM)
        self.assertNotIn(IGNITE_SLOTS_KEY, data)
        self.assertTrue(set_ignite_slot(data, 34, True))
        self.assertTrue(set_ignite_slot(data, 31, True))
        self.assertFalse(set_ignite_slot(data, 31, True), "重复标同一格不算改动")
        self.assertEqual(data[IGNITE_SLOTS_KEY], [31, 34])
        self.assertTrue(set_ignite_slot(data, 31, False))
        self.assertTrue(set_ignite_slot(data, 34, False))
        self.assertFalse(set_ignite_slot(data, 34, False))
        self.assertNotIn(IGNITE_SLOTS_KEY, data, "清空后必须删键，不留 []")

    def test_independent_of_contact_slots(self) -> None:
        data = empty_socket_set(_ANIM)
        set_contact_slot(data, 12, True)
        set_ignite_slot(data, 12, True)
        set_ignite_slot(data, 12, False)
        self.assertEqual(data[CONTACT_SLOTS_KEY], [12], "取消点火接触帧不许动落脚帧")
        self.assertNotIn(IGNITE_SLOTS_KEY, data)


# ---------------------------------------------------------------- 写盘 / 往返

class SanitizeAndSaveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self._path = sockets_path_for_bundle(Path(self._td.name), "b")

    def test_sanitize_keeps_sorted_unique_in_range(self) -> None:
        out = sanitize_socket_set({"sockets": {}, IGNITE_SLOTS_KEY: [38, 31, 31, 200, -3, True]}, _ANIM)
        self.assertEqual(out[IGNITE_SLOTS_KEY], [31, 38])

    def test_no_key_when_unmarked(self) -> None:
        out = sanitize_socket_set({"sockets": {"h": {"poses": {"0": {"x": 0.5, "y": 0.5}}}},
                                   CONTACT_SLOTS_KEY: [12]}, _ANIM)
        self.assertNotIn(IGNITE_SLOTS_KEY, out, "没标过的包不该多出 igniteSlots: []")
        out = sanitize_socket_set({"sockets": {}, IGNITE_SLOTS_KEY: []}, _ANIM)
        self.assertNotIn(IGNITE_SLOTS_KEY, out, "空数组同样不落键（与 contactSlots 同惯例）")

    def test_key_order_follows_contact_slots(self) -> None:
        out = sanitize_socket_set({IGNITE_SLOTS_KEY: [33], CONTACT_SLOTS_KEY: [12],
                                   "sockets": {"h": {"poses": {"0": {"x": 0.5, "y": 0.5}}}}}, _ANIM)
        self.assertEqual(list(out), ["schemaVersion", "atlas", "sockets", CONTACT_SLOTS_KEY, IGNITE_SLOTS_KEY])

    def test_file_without_ignite_roundtrips_byte_identical(self) -> None:
        canon = sanitize_socket_set({
            "sockets": {"right_hand": {"poses": {"30": {"x": 0.51, "y": 0.45, "angle": 90.7}}}},
            CONTACT_SLOTS_KEY: [12, 20],
        }, _ANIM)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        write_json(self._path, canon)
        before = self._path.read_bytes()

        loaded = load_socket_set(self._path)
        self.assertIsNotNone(loaded)
        save_socket_set(self._path, sanitize_socket_set(loaded, _ANIM))
        self.assertEqual(self._path.read_bytes(), before, "打开→不动→保存必须逐字节不变")
        self.assertNotIn(IGNITE_SLOTS_KEY, json.loads(before.decode("utf-8")))

    def test_existing_ignite_key_keeps_value(self) -> None:
        save_socket_set(self._path, sanitize_socket_set({"sockets": {}, IGNITE_SLOTS_KEY: [34, 31]}, _ANIM))
        before = self._path.read_bytes()
        loaded = load_socket_set(self._path)
        self.assertEqual(loaded[IGNITE_SLOTS_KEY], [31, 34])
        save_socket_set(self._path, sanitize_socket_set(loaded, _ANIM))
        self.assertEqual(self._path.read_bytes(), before)

    def test_ignite_only_file_is_kept_and_emptying_deletes(self) -> None:
        save_socket_set(self._path, sanitize_socket_set({"sockets": {}, IGNITE_SLOTS_KEY: [31]}, _ANIM))
        self.assertTrue(self._path.is_file(), "只标了点火接触帧的 sidecar 必须保留")
        on_disk = json.loads(self._path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk[IGNITE_SLOTS_KEY], [31])
        self.assertNotIn(CONTACT_SLOTS_KEY, on_disk)
        self.assertEqual(on_disk["sockets"], {})

        save_socket_set(self._path, sanitize_socket_set({"sockets": {}}, _ANIM))
        self.assertFalse(self._path.is_file(), "三样都没有时不留空壳")

    def test_contact_frames_tool_preserves_ignite_slots(self) -> None:
        """落脚帧推导工具走同一套读写：写 contactSlots 时不许把 igniteSlots 冲掉。"""
        from tools.animation_pipeline.contact_frames import ANIM_ROOT, write_contact_slots

        root = Path(self._td.name) / "proj"
        bundle_dir = root / ANIM_ROOT / "b"
        bundle_dir.mkdir(parents=True)
        anim = dict(_ANIM, states={"walk": {"frames": [12, 13, 14, 15]}, "ignite": {"frames": [30, 31]}})
        (bundle_dir / "anim.json").write_text(json.dumps(anim), encoding="utf-8")
        save_socket_set(bundle_dir / "sockets.json",
                        sanitize_socket_set({"sockets": {}, IGNITE_SLOTS_KEY: [31]}, anim))

        write_contact_slots("b", "walk", [13], root=str(root))
        on_disk = json.loads((bundle_dir / "sockets.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk[CONTACT_SLOTS_KEY], [13])
        self.assertEqual(on_disk[IGNITE_SLOTS_KEY], [31])


# ---------------------------------------------------------------- 面板流程（从控件入口进）

def _first_bundle_with_atlas(model: ProjectModel) -> str:
    for key, anim in sorted(model.animations.items()):
        if isinstance(anim, dict) and anim.get("states") and anim.get("atlasFrames"):
            return key
    raise AssertionError("工程里没有可用的动画包")


class IgnitePanelFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)
        cls._repo = repo_root_from_tests()

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        root = Path(self._td.name) / "p"
        (root / "public/resources/runtime/animation").mkdir(parents=True)
        src = self._repo / "public/resources/runtime/animation"
        # 只拷一个「面板缺省选中的动作（按名排序第一个）至少有 2 个不同槽位」的包：
        # 单帧占位包会让"切帧时勾选框跟着帧走"这类断言整段跳过
        for d in sorted(src.iterdir()):
            aj = d / "anim.json"
            if not aj.is_file():
                continue
            anim = json.loads(aj.read_text(encoding="utf-8"))
            states = anim.get("states") if isinstance(anim, dict) else None
            if not isinstance(states, dict) or not states or not anim.get("atlasFrames"):
                continue
            frames = (states[sorted(states)[0]] or {}).get("frames") or []
            if len(set(frames)) < 2:
                continue
            dst = root / "public/resources/runtime/animation" / d.name
            dst.mkdir(parents=True, exist_ok=True)
            shutil.copy2(aj, dst / "anim.json")
            break
        else:
            self.skipTest("仓库里没有多帧动画包")
        for sub in ("public/assets/data", "public/assets/scenes", "public/assets/dialogues/graphs"):
            (root / sub).mkdir(parents=True, exist_ok=True)
        self._model = ProjectModel()
        self._model.project_path = root
        self._model.reload_animations_from_disk()

    def _open(self) -> tuple[AnimEditor, str]:
        ed = AnimEditor(self._model)
        key = _first_bundle_with_atlas(self._model)
        ed._on_select(key)
        return ed, key

    def _path(self, key: str) -> Path:
        return sockets_path_for_bundle(self._model.animation_bundles_path, key)

    def test_click_marks_dirty_decorates_and_saves_ignite_slots(self) -> None:
        ed, key = self._open()
        panel = ed._socket_panel
        panel._frame_list.setCurrentRow(0)
        slot = panel._current_slot()
        self.assertIsNotNone(slot)
        self.assertTrue(panel._ignite.isEnabled())
        self.assertFalse(panel._ignite.isChecked())
        self.assertFalse(panel.is_dirty())

        panel._ignite.click()   # 真实用户入口：勾「本帧点火接触」
        self.assertTrue(panel.is_ignite_slot(slot))
        self.assertFalse(panel.is_contact_slot(slot), "点火接触帧与落脚帧互不牵连")
        self.assertTrue(panel.is_dirty())
        self.assertTrue(ed._dirty, "脏态必须并进 AnimEditor 的保存/关闭门")
        text = panel._frame_list.item(0).text()
        self.assertIn("点火", text, "帧条里必须一眼看见这一格是点火接触帧")
        self.assertNotIn("落脚", text)
        self.assertTrue(panel._canvas._ignite, "画布要画点火接触帧标记")
        self.assertFalse(panel._canvas._contact)
        self.assertIn(str(slot), panel._ignite_summary.text())
        self.assertIn("#0", panel._ignite_summary.text())

        self.assertIsNone(panel.save())
        path = self._path(key)
        self.assertTrue(path.is_file(), "只有点火接触帧的 sidecar 必须保留")
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data[IGNITE_SLOTS_KEY], [slot])
        self.assertNotIn(CONTACT_SLOTS_KEY, data)
        self.assertEqual(data["sockets"], {})
        self.assertEqual(data["atlas"]["slotCount"], len(self._model.animations[key]["atlasFrames"]))
        self.assertFalse(panel.is_dirty())

        # 重新载入：标记还在，切帧时勾选框跟着帧走
        ed._on_select(key)
        panel = ed._socket_panel
        panel._frame_list.setCurrentRow(0)
        self.assertTrue(panel._ignite.isChecked())
        self.assertFalse(panel.is_dirty(), "打开即脏是红线")
        self.assertGreater(panel._frame_list.count(), 1)
        panel._frame_list.setCurrentRow(1)
        self.assertFalse(panel._ignite.isChecked())
        self.assertFalse(panel._canvas._ignite)

        # 取消勾 → 脏 → 保存：三样都空 → 删文件
        panel._frame_list.setCurrentRow(0)
        panel._ignite.click()
        self.assertTrue(panel.is_dirty())
        self.assertIsNone(panel.save())
        self.assertFalse(path.is_file(), "既没挂点、落脚帧也没点火接触帧时不留空壳")

    def test_contact_and_ignite_on_same_slot_both_land(self) -> None:
        ed, key = self._open()
        panel = ed._socket_panel
        panel._frame_list.setCurrentRow(0)
        slot = panel._current_slot()
        panel._contact.click()
        panel._ignite.click()
        text = panel._frame_list.item(0).text()
        self.assertIn("落脚", text)
        self.assertIn("点火", text)
        self.assertIsNone(panel.save())
        data = json.loads(self._path(key).read_text(encoding="utf-8"))
        self.assertEqual(data[CONTACT_SLOTS_KEY], [slot])
        self.assertEqual(data[IGNITE_SLOTS_KEY], [slot])
        self.assertEqual(list(data)[-2:], [CONTACT_SLOTS_KEY, IGNITE_SLOTS_KEY])

        panel._contact.click()   # 取消落脚，点火保留
        self.assertIsNone(panel.save())
        data = json.loads(self._path(key).read_text(encoding="utf-8"))
        self.assertNotIn(CONTACT_SLOTS_KEY, data)
        self.assertEqual(data[IGNITE_SLOTS_KEY], [slot])

    def test_open_untouched_save_is_byte_identical_without_ignite_key(self) -> None:
        ed, key = self._open()
        panel = ed._socket_panel
        panel._frame_list.setCurrentRow(0)
        panel._contact.click()
        self.assertIsNone(panel.save())
        path = self._path(key)
        before = path.read_bytes()
        self.assertNotIn(IGNITE_SLOTS_KEY, json.loads(before.decode("utf-8")))

        ed._on_select(key)
        panel = ed._socket_panel
        self.assertFalse(panel.is_dirty())
        self.assertIsNone(panel.save())
        self.assertEqual(path.read_bytes(), before, "没有 igniteSlots 的文件打开→不动→保存必须逐字节不变")

    def test_discard_rolls_back_ignite_marks(self) -> None:
        ed, _key = self._open()
        panel = ed._socket_panel
        panel._frame_list.setCurrentRow(0)
        slot = panel._current_slot()
        panel._ignite.click()
        self.assertTrue(panel.is_dirty())
        panel.discard()
        self.assertFalse(panel.is_dirty())
        self.assertFalse(panel.is_ignite_slot(slot))
        self.assertFalse(panel._ignite.isChecked())

    def test_stale_follows_contact_rules_and_resave_refreshes_fingerprint(self) -> None:
        ed, key = self._open()
        anim = self._model.animations[key]
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schemaVersion": 1,
            "atlas": {
                "cols": int(anim.get("cols") or 1) + 7,
                "rows": int(anim.get("rows") or 1) + 7,
                "slotCount": len(anim.get("atlasFrames") or []) + 7,
            },
            "sockets": {},
            CONTACT_SLOTS_KEY: [0],
        }), encoding="utf-8")
        ed._on_select(key)
        panel = ed._socket_panel
        self.assertTrue(panel._stale)
        self.assertTrue(panel._banner.isVisibleTo(panel))
        self.assertIn("点火", panel._banner.text(), "失效横幅要说清点火接触帧也作废")
        self.assertFalse(panel.is_dirty())

        panel._frame_list.setCurrentRow(0)
        self.assertEqual(panel._ignite.isEnabled(), panel._contact.isEnabled(),
                         "点火接触帧的启用规则必须与落脚帧同一套")
        slot = panel._current_slot()
        self.assertFalse(panel.is_ignite_slot(slot))
        panel._ignite.click()       # 重标
        self.assertTrue(panel.is_dirty())
        self.assertIsNone(panel.save())
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["atlas"]["slotCount"], len(anim["atlasFrames"]), "重标保存才刷新指纹")
        self.assertIn(slot, data[IGNITE_SLOTS_KEY])
        self.assertFalse(panel._stale)

    def test_preview_info_flags_only_first_ignite_frame(self) -> None:
        ed, _key = self._open()
        panel = ed._socket_panel
        panel._frame_list.setCurrentRow(0)
        slot = panel._current_slot()
        panel._ignite.click()
        other = slot + 1
        ed._preview_frames = [other, slot, other, slot]
        for i, expect in enumerate([False, True, False, False]):
            ed._preview_seq_i = i
            ed._update_preview_info("ignite", 4, 0)
            with self.subTest(i=i):
                self.assertEqual("点火接触帧" in ed._lbl_preview_info.text(), expect,
                                 "只标运行时真正取的那一帧：序列里第一个标了的帧")


if __name__ == "__main__":
    unittest.main()
