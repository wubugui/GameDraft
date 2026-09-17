"""挂件灯 `flicker` 的两种写法（2026-09-15）在编辑器侧的登记面。

运行时权威：`src/data/propPresets.ts::parsePropLight`——
- 物理 `{kind: "flame" | "ember", diameter, puffAmp?}`：`kind` 严格等于两者之一才走这条；
  `diameter` 拿不到 > 0 的有限数（`Number()` 口径）⇒ 整块丢掉；`puffAmp` 只明火读、夹 0..1、非数当没写；
- 正弦 `{amp, hz, windAmp?}`（灯笼）：不写 `kind`；`kind` 是别的值时也按这条解析（kind 被忽略）。

覆盖：
1. **校验器**：每条护栏先把数据改坏一次，确认它真的红 / 黄；正弦老写法的护栏不变。
2. **表单往返**：两种写法、残留键、怪 `kind`、坏值——打开→不动→dump 逐字节不变。
3. **切种类**：写上这一种的键、删掉另一种的键，一次切换只发一次 changed；切回去逐字节还原。
4. 状态里的灯是同一个表单，同一套控件；挂件预设页整页往返（合成两种写法 + 现网数据真的两种都有）。

Python 侧**没有**闪烁的预览镜像（`prop_preview.py` 不解析 `light`），所以这里没有跨语言 parity 用例。
"""
from __future__ import annotations

import copy
import json
import os
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QComboBox  # noqa: E402

from tools.editor.editors.prop_preset_blocks import (  # noqa: E402
    FLICKER_KIND_EMBER,
    FLICKER_KIND_FLAME,
    FLICKER_KIND_RAW,
    FLICKER_KIND_SINE,
    PropLightForm,
    WIND_SHELTER_TIP,
    PropStateLightField,
    flicker_problems,
)
from tools.editor.editors.prop_preset_editor import PropPresetEditor  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402

_REAL_IMAGE = "/resources/runtime/images/icons/taomu_sword.png"
_LANTERN_TIP = "灯笼（正弦）是逐项调过的，别改它的种类"


def _app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _bytes(v: object) -> str:
    return json.dumps(v, ensure_ascii=False, indent=2)


def _light(flicker: object) -> dict:
    return {"kelvin": 1900, "intensity": 0.1, "range": 300, "flicker": flicker, "castShadow": False}


class _FormCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def _form(self, light: dict | None) -> PropLightForm:
        form = PropLightForm()
        self.addCleanup(form.deleteLater)
        form.set_data(copy.deepcopy(light) if light is not None else None)
        return form

    @staticmethod
    def _select(form: PropLightForm, kind: str) -> None:
        """像用户那样在下拉里选一档（发 currentIndexChanged）。"""
        idx = form._flk_kind.findData(kind)
        assert idx >= 0, kind
        form._flk_kind.setCurrentIndex(idx)

    @staticmethod
    def _visible_rows(form: PropLightForm) -> set[str]:
        ff = form._flicker_form
        names = {
            "diameter": form._diameter, "puffAmp": form._puff,
            "amp": form._amp, "hz": form._hz, "windAmp": form._wind,
        }
        return {k for k, w in names.items() if ff.isRowVisible(w)}


class FlickerValidatorTests(unittest.TestCase):
    """校验器：物理写法的每条护栏先改坏一次；正弦写法口径不变。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.model = ProjectModel()
        cls.model.load_project(_ROOT)

    def _issues(self, flicker: object, *, in_state: bool = False) -> list:
        from tools.editor.validator import _validate_prop_presets
        entry: dict = {"image": _REAL_IMAGE, "light": _light({"amp": 0.2, "hz": 8})}
        if in_state:
            entry["states"] = {"ember": {"light": {"intensity": 0.05, "flicker": flicker}}}
            entry["defaultState"] = "ember"
        else:
            entry["light"] = _light(flicker)
        self.model.prop_presets = {"t": copy.deepcopy(entry)}
        out: list = []
        _validate_prop_presets(self.model, out)
        return out

    def _errors(self, flicker: object, **kw) -> list[str]:
        return [i.message for i in self._issues(flicker, **kw) if i.severity == "error"]

    def _warnings(self, flicker: object, **kw) -> list[str]:
        return [i.message for i in self._issues(flicker, **kw) if i.severity == "warning"]

    def test_healthy_physical_forms_are_clean(self) -> None:
        for flk in ({"kind": "flame", "diameter": 0.1},
                    {"kind": "ember", "diameter": 0.1},
                    {"kind": "flame", "diameter": 0.1, "puffAmp": 0.3},
                    {"kind": "flame", "diameter": 1, "puffAmp": 0},
                    {"kind": "flame", "diameter": 0.1, "puffAmp": 1}):
            for in_state in (False, True):
                with self.subTest(flk=flk, in_state=in_state):
                    self.assertEqual(
                        [i.message for i in self._issues(flk, in_state=in_state)], [])

    def test_physical_without_positive_diameter_is_an_error(self) -> None:
        for flk in ({"kind": "flame"}, {"kind": "ember"},
                    {"kind": "flame", "diameter": 0}, {"kind": "flame", "diameter": -0.1},
                    {"kind": "ember", "diameter": None}, {"kind": "flame", "diameter": "粗"},
                    {"kind": "flame", "diameter": {}}):
            for in_state in (False, True):
                with self.subTest(flk=flk, in_state=in_state):
                    msgs = self._errors(flk, in_state=in_state)
                    self.assertTrue(
                        any("diameter" in m and "灯不闪" in m for m in msgs),
                        f"{flk!r} 运行时整块丢掉，应报 error：{msgs}")
                    if in_state:
                        self.assertTrue(any("states[ember].light.flicker" in m for m in msgs), msgs)

    def test_physical_without_amp_hz_is_not_a_sine_error(self) -> None:
        """写了物理 kind 就不该再按正弦查 amp/hz（旧校验器就是在这里对着火把报了 4 条假 error）。"""
        msgs = self._errors({"kind": "flame", "diameter": 0.1})
        self.assertFalse(any("amp" in m for m in msgs), msgs)

    def test_coerced_diameter_is_only_a_warning(self) -> None:
        """`Number("0.1")` 运行时照用：报 error 就比 TS 更严（norms 不变量 7）。"""
        flk = {"kind": "flame", "diameter": "0.1"}
        self.assertEqual(self._errors(flk), [])
        self.assertTrue(any("diameter" in m for m in self._warnings(flk)))

    def test_puff_amp_out_of_range_or_not_a_number_warns(self) -> None:
        for puff, needle in ((1.5, "0..1"), (-0.2, "0..1"), ("大", "不是数"), ({}, "不是数"),
                             (None, "null")):
            flk = {"kind": "flame", "diameter": 0.1, "puffAmp": puff}
            with self.subTest(puff=puff):
                self.assertEqual(self._errors(flk), [])
                w = self._warnings(flk)
                self.assertTrue(any("puffAmp" in m and needle in m for m in w), w)

    def test_puff_amp_on_ember_warns(self) -> None:
        flk = {"kind": "ember", "diameter": 0.1, "puffAmp": 0.2}
        self.assertEqual(self._errors(flk), [])
        self.assertTrue(any("炭火不读 puffAmp" in m for m in self._warnings(flk)))

    def test_sine_keys_next_to_a_physical_kind_warn(self) -> None:
        for extra in ({"amp": 0.2}, {"hz": 8}, {"windAmp": 0.5}, {"amp": 0.2, "hz": 8, "windAmp": 1}):
            flk = {"kind": "ember", "diameter": 0.1, **extra}
            with self.subTest(extra=extra):
                self.assertEqual(self._errors(flk), [])
                w = self._warnings(flk)
                self.assertTrue(any("写了 kind 就不读 amp/hz/windAmp" in m for m in w), w)

    def test_unknown_kind_is_an_error(self) -> None:
        for kind in ("flames", "Flame", "sine", "", 1, None):
            for rest in ({}, {"diameter": 0.1}, {"amp": 0.2, "hz": 8}):
                flk = {"kind": kind, **rest}
                with self.subTest(flk=flk):
                    msgs = self._errors(flk)
                    self.assertTrue(any("kind=" in m and "运行时不认" in m for m in msgs), msgs)

    def test_unknown_kind_with_full_sine_reports_only_the_kind(self) -> None:
        msgs = self._errors({"kind": "flames", "amp": 0.2, "hz": 8})
        self.assertEqual(len(msgs), 1, msgs)

    def test_unknown_kind_still_runs_sine_checks_when_sine_keys_are_written(self) -> None:
        msgs = self._errors({"kind": "flames", "amp": 0.2})
        self.assertTrue(any("amp 与 hz" in m for m in msgs), msgs)

    def test_sine_form_checks_are_unchanged(self) -> None:
        self.assertEqual(self._issues({"amp": 0.1, "hz": 0.5, "windAmp": 0.5}), [])
        for flk in ({"amp": 0.2}, {"hz": 8}, {"amp": 0, "hz": 8}, {}):
            with self.subTest(flk=flk):
                self.assertTrue(any("amp 与 hz" in m for m in self._errors(flk)))
        self.assertTrue(any("windAmp" in m for m in self._errors({"amp": 0.2, "hz": 8, "windAmp": "x"})))

    def test_non_object_flicker_names_both_forms(self) -> None:
        msgs = self._errors([0.2, 8])
        self.assertTrue(any("kind" in m and "amp" in m for m in msgs), msgs)


class FlickerFormRoundtripTests(_FormCase):
    """打开→不动→dump 逐字节不变（含坏值、残留键、怪 kind）。"""

    SHAPES = (
        {"kind": "flame", "diameter": 0.1},
        {"kind": "ember", "diameter": 0.1},
        {"kind": "flame", "diameter": 0.125, "puffAmp": 0.25},
        {"kind": "flame", "diameter": 1, "puffAmp": 0},
        {"amp": 0.1, "hz": 0.5, "windAmp": 0.5},          # 灯笼
        {"amp": 0.45, "hz": 11, "windAmp": 0.8},
        {"diameter": 0.1, "kind": "flame", "备注": {"x": [1, 2]}},   # 键序 + 不认识的键
        {"kind": "flames", "amp": 0.2, "hz": 8},          # 运行时不认的 kind
        {"kind": 1},
        {"kind": "flame"},                                # 坏：没直径
        {"kind": "flame", "diameter": 0},                 # 坏：直径 0（控件最小 0.01）
        {"kind": "flame", "diameter": 3.5, "puffAmp": 7},  # 越界
        {"kind": "flame", "diameter": "0.1", "puffAmp": "0.2"},
        {"kind": "ember", "diameter": 0.1, "puffAmp": 0.2, "amp": 0.2},   # 残留键
        {"amp": 0.2},                                     # 坏：正弦半配
    )

    def test_untouched_flicker_is_byte_identical(self) -> None:
        for flk in self.SHAPES:
            with self.subTest(flk=flk):
                light = _light(flk)
                form = self._form(light)
                self.assertEqual(_bytes(form.dump()), _bytes(light))

    def test_editing_another_light_field_keeps_flicker_bytes(self) -> None:
        for flk in self.SHAPES:
            with self.subTest(flk=flk):
                light = _light(flk)
                form = self._form(light)
                form._intensity.setValue(0.3)
                out = form.dump()
                self.assertEqual(out["intensity"], 0.3)
                self.assertEqual(_bytes(out["flicker"]), _bytes(flk))

    def test_kind_on_load_picks_the_right_row(self) -> None:
        cases = (
            ({"kind": "flame", "diameter": 0.1}, FLICKER_KIND_FLAME, {"diameter", "puffAmp"}),
            ({"kind": "ember", "diameter": 0.1}, FLICKER_KIND_EMBER, {"diameter"}),
            ({"amp": 0.1, "hz": 0.5}, FLICKER_KIND_SINE, {"amp", "hz", "windAmp"}),
            ({"kind": "flames", "amp": 0.1, "hz": 0.5}, FLICKER_KIND_RAW, {"amp", "hz", "windAmp"}),
        )
        for flk, want, rows in cases:
            with self.subTest(flk=flk):
                form = self._form(_light(flk))
                self.assertIsInstance(form._flk_kind, QComboBox)
                self.assertEqual(form._flk_kind.currentData(), want)
                self.assertEqual(self._visible_rows(form), rows)

    def test_unknown_kind_is_shown_not_replaced(self) -> None:
        form = self._form(_light({"kind": "flames", "amp": 0.2, "hz": 8}))
        self.assertIn("flames", form._flk_kind.currentText())
        # 重载一块正常的：怪值那一行不能残留在下拉里
        form.set_data(_light({"kind": "ember", "diameter": 0.1}))
        self.assertEqual(form._flk_kind.findData(FLICKER_KIND_RAW), -1)
        self.assertEqual(form._flk_kind.count(), 3)

    def test_load_does_not_emit_changed(self) -> None:
        form = PropLightForm()
        self.addCleanup(form.deleteLater)
        hits: list[int] = []
        form.changed.connect(lambda: hits.append(1))
        for flk in self.SHAPES:
            form.set_data(_light(flk))
        self.assertEqual(hits, [], "载入不是用户改动，发 changed = 打开即脏")


class FlickerKindSwitchTests(_FormCase):
    """切种类 = 写上这一种的键、删掉另一种的键，一次切换一次 changed。"""

    def test_sine_to_flame_writes_physical_keys_only(self) -> None:
        lantern = {"amp": 0.1, "hz": 0.5, "windAmp": 0.5, "备注": "留着"}
        form = self._form(_light(lantern))
        hits: list[int] = []
        form.changed.connect(lambda: hits.append(1))
        self._select(form, FLICKER_KIND_FLAME)
        self.assertEqual(hits, [1], "切一次种类就是一次改动")
        self.assertEqual(form.dump()["flicker"], {"备注": "留着", "kind": "flame", "diameter": 0.1})
        self.assertEqual(self._visible_rows(form), {"diameter", "puffAmp"})

    def test_flame_to_sine_writes_sine_keys_only(self) -> None:
        form = self._form(_light({"kind": "flame", "diameter": 0.1, "puffAmp": 0.3}))
        self._select(form, FLICKER_KIND_SINE)
        flk = form.dump()["flicker"]
        self.assertEqual(set(flk), {"amp", "hz"})
        self.assertGreater(flk["amp"], 0)
        self.assertGreater(flk["hz"], 0)
        self.assertEqual(flicker_problems(flk), [], "切过去的正弦块必须是运行时收的")

    def test_switching_away_and_back_restores_bytes(self) -> None:
        for flk, via in (({"amp": 0.1, "hz": 0.5, "windAmp": 0.5}, FLICKER_KIND_FLAME),
                         ({"kind": "flame", "diameter": 0.125, "puffAmp": 0.25}, FLICKER_KIND_SINE),
                         ({"kind": "flame", "diameter": 0.1, "puffAmp": 0.25}, FLICKER_KIND_EMBER),
                         ({"kind": "flames", "amp": 0.2, "hz": 8}, FLICKER_KIND_EMBER)):
            with self.subTest(flk=flk, via=via):
                form = self._form(_light(flk))
                back = form._flk_kind.currentData()
                self._select(form, via)
                self.assertNotEqual(_bytes(form.dump()["flicker"]), _bytes(flk))
                self._select(form, back)
                self.assertEqual(_bytes(form.dump()["flicker"]), _bytes(flk))

    def test_flame_to_ember_drops_puff_amp(self) -> None:
        form = self._form(_light({"kind": "flame", "diameter": 0.1, "puffAmp": 0.3}))
        self._select(form, FLICKER_KIND_EMBER)
        self.assertEqual(form.dump()["flicker"], {"kind": "ember", "diameter": 0.1})
        self.assertEqual(self._visible_rows(form), {"diameter"})

    def test_editing_diameter_and_puff(self) -> None:
        form = self._form(_light({"kind": "flame", "diameter": 0.1}))
        form._diameter.setValue(0.25)
        self.assertEqual(form.dump()["flicker"], {"kind": "flame", "diameter": 0.25})
        form._puff._on.setChecked(True)
        self.assertEqual(form.dump()["flicker"]["puffAmp"], 0.1, "勾上「写」= 写缺省 0.1")
        form._puff._spin.setValue(0.4)
        self.assertEqual(form.dump()["flicker"], {"kind": "flame", "diameter": 0.25, "puffAmp": 0.4})
        form._puff._on.setChecked(False)
        self.assertNotIn("puffAmp", form.dump()["flicker"], "不勾 = 不写 = 运行时 0.1")

    def test_touched_block_keeps_raw_values_of_untouched_fields(self) -> None:
        form = self._form(_light({"kind": "flame", "diameter": "0.1", "puffAmp": 7}))
        form._diameter.setValue(0.2)
        self.assertEqual(form.dump()["flicker"], {"kind": "flame", "diameter": 0.2, "puffAmp": 7})

    def test_editing_amp_keeps_an_unknown_kind(self) -> None:
        form = self._form(_light({"kind": "flames", "amp": 0.2, "hz": 8}))
        form._amp.setValue(0.3)
        self.assertEqual(form.dump()["flicker"], {"kind": "flames", "amp": 0.3, "hz": 8})

    def test_new_flicker_defaults_to_flame(self) -> None:
        form = self._form({"intensity": 0.1})
        form._flicker_on.setChecked(True)
        self.assertEqual(form.dump()["flicker"], {"kind": "flame", "diameter": 0.1})

    def test_note_names_the_silent_drop(self) -> None:
        form = self._form(_light({"kind": "flame"}))
        self.assertIn("燃烧面直径", form._note.text())
        form._diameter.setValue(0.2)
        self.assertNotIn("燃烧面直径", form._note.text())
        form = self._form(_light({"kind": "ember", "diameter": 0.1}))
        self.assertEqual(form._note.text(), "")

    def test_tooltips(self) -> None:
        form = self._form(None)
        tip = form._flk_kind.toolTip()
        for needle in (_LANTERN_TIP, "1.5/√D", "√(gD)", "−0.21", "炭火", "1 − 挡风"):
            self.assertIn(needle, tip)
        self.assertEqual([form._flk_kind.itemText(i) for i in range(form._flk_kind.count())],
                         ["明火（物理）", "炭火（物理）", "正弦（老写法）"])
        # 挡风不改灯的数值，但物理闪烁读挡过风的气流：旧说明「不改灯」一句话就误导了
        self.assertIn("物理闪烁", WIND_SHELTER_TIP)

    def test_rows_are_not_squeezed_flat(self) -> None:
        """切种类后闪烁那一片按新行数撑开、实际高度不小于它要的高度。

        ⚠ 不是 `_relayout_up` 的护栏：把那一行删掉这条照样绿（`QFormLayout.setRowVisible`
        自己会 invalidate）。它钉的是「显隐走行级、外层确实给到了高度」这个结果。
        """
        form = self._form(_light({"kind": "ember", "diameter": 0.1}))
        form.show()
        ember_h = form._flicker_fields.sizeHint().height()
        self._select(form, FLICKER_KIND_SINE)
        sine_h = form._flicker_fields.sizeHint().height()
        self.assertGreater(sine_h, ember_h, "正弦三行应比炭火一行高")
        form.resize(form.sizeHint())
        QApplication.processEvents()
        self.assertGreaterEqual(form._flicker_fields.height(), sine_h,
                                "切到正弦后闪烁那一片被压扁了（中间层没刷新几何）")


class FlickerHostSurfaceTests(_FormCase):
    """状态里的灯 + 挂件预设整页。"""

    def test_state_light_form_has_the_same_control(self) -> None:
        field = PropStateLightField()
        self.addCleanup(field.deleteLater)
        field.set_data({"light": {"intensity": 0.05, "flicker": {"kind": "ember", "diameter": 0.1}}})
        self.assertIsInstance(field._form, PropLightForm)
        self.assertEqual(field._form._flk_kind.currentData(), FLICKER_KIND_EMBER)
        self._select(field._form, FLICKER_KIND_FLAME)
        out: dict = {}
        field.write_into(out)
        self.assertEqual(out["light"]["flicker"], {"kind": "flame", "diameter": 0.1})

    def test_preset_page_roundtrips_both_forms(self) -> None:
        model = ProjectModel()
        model.load_project(_ROOT)
        table = {
            "lantern": {"image": _REAL_IMAGE,
                        "light": _light({"amp": 0.1, "hz": 0.5, "windAmp": 0.5}),
                        "states": {"g": {"light": {"intensity": 0.45,
                                                   "flicker": {"amp": 0.45, "hz": 11}}}}},
            "torch": {"image": _REAL_IMAGE,
                      "light": _light({"kind": "flame", "diameter": 0.1, "puffAmp": 0.15, "x": 1}),
                      "states": {"guarding": {"light": {"intensity": 0.08}},
                                 "ember": {"light": {"intensity": 0.05,
                                                     "flicker": {"kind": "ember", "diameter": 0.1}}},
                                 "out": {"light": None}},
                      "defaultState": "guarding"},
        }
        model.prop_presets = copy.deepcopy(table)
        ed = PropPresetEditor(model)
        try:
            out = ed._staged()
            self.assertFalse(ed._dirty, "打开即脏是红线")
        finally:
            ed.deleteLater()
        self.assertEqual(_bytes(out), _bytes(table))

    def test_real_data_exercises_both_forms(self) -> None:
        """现网字节级往返（test_held_prop_editor_surfaces）只有在数据里两种写法都在时才算覆盖到。"""
        data = json.loads((_ROOT / "public/assets/data/prop_presets.json").read_text(encoding="utf-8"))
        kinds: set[object] = set()
        for entry in data.values():
            lights = [entry.get("light")] + [
                (s or {}).get("light") for s in (entry.get("states") or {}).values()]
            for light in lights:
                if isinstance(light, dict) and isinstance(light.get("flicker"), dict):
                    kinds.add(light["flicker"].get("kind", FLICKER_KIND_SINE))
        self.assertTrue({FLICKER_KIND_SINE, FLICKER_KIND_FLAME, FLICKER_KIND_EMBER} <= kinds, kinds)


if __name__ == "__main__":
    unittest.main()
