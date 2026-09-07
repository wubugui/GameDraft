"""落脚帧（`sockets.json.contactSlots`）的读写规则与校验。

落脚帧与挂点同住一份 sidecar、同一份图集指纹。这里钉死：
- 规整口径与 TS 侧 `parseContactSlots` 逐值一致（同一组脏输入两边得同一个答案）；
- 只标了落脚帧、一个挂点都没有的文件**必须保留**（会走路的包大多如此）；
  两样都没有才删；
- 未标过的包写盘不多出一个 `contactSlots: []`（往返干净）；
- 校验器：纯落脚帧文件不是「空壳」；越界槽位是 error。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any

from tools.editor.shared.animation_sockets import (
    CONTACT_SLOTS_KEY,
    contact_slots_of,
    empty_socket_set,
    normalize_contact_slots,
    sanitize_socket_set,
    save_socket_set,
    set_contact_slot,
    sockets_path_for_bundle,
)
from tools.editor.validator import _validate_animation_sockets

_ANIM: dict[str, Any] = {
    "cols": 9, "rows": 10,
    "atlasFrames": [{"width": 1, "height": 1} for _ in range(89)],
    "states": {"walk": {"frames": list(range(9, 25)), "frameRate": 8}},
}


class NormalizeTests(unittest.TestCase):
    def test_parity_with_ts_parse_contact_slots(self) -> None:
        """与 `src/data/animationSockets.test.ts` 的同名用例同一组输入、同一个答案。"""
        raw = [20, 12, 12, -1, 2.5, "30", 999, 38]
        self.assertEqual(normalize_contact_slots(raw, 89), [12, 20, 38])

    def test_bool_is_not_a_slot(self) -> None:
        self.assertEqual(normalize_contact_slots([True, 3, False], 89), [3])

    def test_integral_float_is_accepted(self) -> None:
        self.assertEqual(normalize_contact_slots([12.0, 20.0], 89), [12, 20])

    def test_non_list_is_empty(self) -> None:
        for bad in (None, "12", {"0": 1}, 12):
            with self.subTest(bad=bad):
                self.assertEqual(normalize_contact_slots(bad, 89), [])

    def test_no_upper_bound_when_slot_count_unknown(self) -> None:
        self.assertEqual(normalize_contact_slots([999, 3], 0), [3, 999])


class SetContactSlotTests(unittest.TestCase):
    def test_toggle_on_off_and_key_removed_when_empty(self) -> None:
        data = empty_socket_set(_ANIM)
        self.assertNotIn(CONTACT_SLOTS_KEY, data, "空集不该带 contactSlots 键")
        self.assertTrue(set_contact_slot(data, 20, True))
        self.assertTrue(set_contact_slot(data, 12, True))
        self.assertFalse(set_contact_slot(data, 12, True), "重复标同一格不算改动")
        self.assertEqual(data[CONTACT_SLOTS_KEY], [12, 20])
        self.assertTrue(set_contact_slot(data, 12, False))
        self.assertTrue(set_contact_slot(data, 20, False))
        self.assertFalse(set_contact_slot(data, 20, False))
        self.assertNotIn(CONTACT_SLOTS_KEY, data, "清空后必须删键，不留 []")

    def test_contact_slots_of_tolerates_garbage(self) -> None:
        self.assertEqual(contact_slots_of(None), [])
        self.assertEqual(contact_slots_of({CONTACT_SLOTS_KEY: "x"}), [])
        self.assertEqual(contact_slots_of({CONTACT_SLOTS_KEY: [5, 1, 1]}), [1, 5])


class SanitizeTests(unittest.TestCase):
    def test_keeps_sorted_unique_in_range(self) -> None:
        data = {"sockets": {}, CONTACT_SLOTS_KEY: [38, 12, 12, 200, -3]}
        out = sanitize_socket_set(data, _ANIM)
        self.assertEqual(out[CONTACT_SLOTS_KEY], [12, 38], "越界（≥ slotCount）与负数被裁掉")
        self.assertEqual(out["atlas"]["slotCount"], 89)

    def test_empty_contact_slots_do_not_land_as_key(self) -> None:
        out = sanitize_socket_set({"sockets": {"h": {"poses": {"0": {"x": 0.5, "y": 0.5}}}}}, _ANIM)
        self.assertNotIn(CONTACT_SLOTS_KEY, out, "没标过的包不该多出 contactSlots: []")

    def test_sockets_survive_alongside_contact_slots(self) -> None:
        out = sanitize_socket_set({
            "sockets": {"h": {"poses": {"0": {"x": 0.5, "y": 0.5}}}},
            CONTACT_SLOTS_KEY: [12],
        }, _ANIM)
        self.assertEqual(list(out["sockets"]), ["h"])
        self.assertEqual(out[CONTACT_SLOTS_KEY], [12])


class SaveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self._path = sockets_path_for_bundle(Path(self._td.name), "b")

    def test_contact_only_file_is_kept(self) -> None:
        data = sanitize_socket_set({"sockets": {}, CONTACT_SLOTS_KEY: [12, 20]}, _ANIM)
        save_socket_set(self._path, data)
        self.assertTrue(self._path.is_file(), "只有落脚帧、没有挂点的 sidecar 必须保留")
        on_disk = json.loads(self._path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk[CONTACT_SLOTS_KEY], [12, 20])
        self.assertEqual(on_disk["sockets"], {})

    def test_neither_sockets_nor_contact_deletes_file(self) -> None:
        save_socket_set(self._path, sanitize_socket_set({"sockets": {}, CONTACT_SLOTS_KEY: [12]}, _ANIM))
        self.assertTrue(self._path.is_file())
        save_socket_set(self._path, sanitize_socket_set({"sockets": {}}, _ANIM))
        self.assertFalse(self._path.is_file(), "两样都没有时不留空壳")


class ValidatorTests(unittest.TestCase):
    def _issues(self, sidecar: dict | None) -> list[str]:
        with TemporaryDirectory() as td:
            root = Path(td)
            bundles = root / "animation"
            if sidecar is not None:
                p = sockets_path_for_bundle(bundles, "player_anim")
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(sidecar), encoding="utf-8")
            model = SimpleNamespace(
                project_path=root,
                animation_bundles_path=bundles,
                animations={"player_anim": _ANIM},
            )
            out: list[Any] = []
            _validate_animation_sockets(model, out)  # type: ignore[arg-type]
            return [f"[{i.severity}] {i.message}" for i in out]

    @staticmethod
    def _fp() -> dict[str, int]:
        return {"cols": 9, "rows": 10, "slotCount": 89}

    def test_contact_only_file_is_not_an_empty_shell(self) -> None:
        self.assertEqual(self._issues({"atlas": self._fp(), "sockets": {}, CONTACT_SLOTS_KEY: [12, 20]}), [])

    def test_truly_empty_file_is_a_shell(self) -> None:
        msgs = self._issues({"atlas": self._fp(), "sockets": {}})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("空壳", msgs[0])

    def test_out_of_range_slot_is_an_error(self) -> None:
        msgs = self._issues({"atlas": self._fp(), "sockets": {}, CONTACT_SLOTS_KEY: [12, 89, -1, True]})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertTrue(msgs[0].startswith("[error]"))
        self.assertIn("89", msgs[0])
        self.assertIn("-1", msgs[0])
        self.assertIn("True", msgs[0])

    def test_wrong_shape_is_an_error(self) -> None:
        msgs = self._issues({"atlas": self._fp(), "sockets": {}, CONTACT_SLOTS_KEY: "12"})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("须为槽位数组", msgs[0])

    def test_stale_fingerprint_silences_footsteps_too(self) -> None:
        msgs = self._issues({"atlas": {"cols": 1, "rows": 1, "slotCount": 1}, "sockets": {},
                             CONTACT_SLOTS_KEY: [0]})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("脚步不响", msgs[0])

    def test_no_sidecar_is_silent(self) -> None:
        self.assertEqual(self._issues(None), [])


if __name__ == "__main__":
    unittest.main()
