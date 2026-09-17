"""手持光源（火把）在编辑器侧的四个登记面。

覆盖（每一条都对应一个"漏了会静默"的口子）：

1. **挂件预设页往返保真**：真实数据 / 填满形态 / 最小形态「打开→什么都不改→保存」
   逐值不变；新增的可选键**不凭空多出来**（加可选参数必须单独探这一条，
   见 action-registration-registry-surfaces 的已知坑）。
2. **状态里 `light` 是三态**（不写 = 沿用基础块 / `null` = 这个状态没有灯 / 对象 = 覆盖）。
   做成两态就配不出"火把灭了"，而那是这个特性的主要用例。
3. **两个新动作 + 一个新参数**的往返与控件契约（禁裸 QLineEdit、悬垂值保值、
   `fadeMs` / `state` 缺省不写键）。
4. **场景灯 `follow.target` 的重构跟随**：scan 点名、rename 机械跟随、
   move 只报不改、undo-move 不反向瞎改。
5. **校验器**：每一条护栏都先把数据改坏一次，确认它真的红
   （editor-change-verification-gate：护栏本身可能是假的）。
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

from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from tools.editor.editors.prop_preset_blocks import (  # noqa: E402
    STATE_LIGHT_INHERIT,
    STATE_LIGHT_NONE,
    STATE_LIGHT_OWN,
    PropLightForm,
    PropStatesEditor,
    STATE_PARTICLES_INHERIT,
    STATE_PARTICLES_OWN,
    ParticleMountListField,
)
from tools.editor.editors.prop_preset_editor import PropPresetEditor  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    ActionEditor,
    ActionRow,
    FilterableTypeCombo,
)
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402

_REAL_IMAGE = "/resources/runtime/images/icons/taomu_sword.png"


def _app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _model() -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
    return m


#: 一条把所有新字段都填满的预设（形状逐字照 `src/data/propPresets.ts`）。
FULL_PRESET = {
    "label": "火把",
    "image": _REAL_IMAGE,
    "anchorX": 0.5,
    "anchorY": 0.9,
    "rotation": 0,          # int，不得漂成 0.0
    "scale": 1,             # 同上
    "lit": False,
    "light": {
        "socket": "torch_tip",
        "offset": [0, 10, 0],
        "kelvin": 1900,
        "intensity": 2,
        "range": 300,
        "softeningRadius": 8,
        "castShadow": False,
        "flicker": {"amp": 0.2, "hz": 8, "windAmp": 0.5},
    },
    "particles": [],
    "persistent": True,
    "states": {
        "lit": {"label": "点着"},
        "ember": {"label": "残炭", "light": {"intensity": 1}, "scale": 1},
        "out": {"label": "灭", "light": None, "particles": [], "lit": True},
    },
    "defaultState": "lit",
}


class PropPresetRoundtripTests(unittest.TestCase):
    """打开→不动→保存 = 磁盘等价。三种形态各探一次。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()
        cls.model = _model()

    def _roundtrip(self, table: dict) -> dict:
        self.model.prop_presets = copy.deepcopy(table)
        ed = PropPresetEditor(self.model)
        try:
            out = ed._staged()
            self.assertFalse(ed._dirty, "打开即脏是红线")
            return out
        finally:
            ed.deleteLater()

    def test_real_project_table_roundtrips_byte_for_byte(self) -> None:
        """字节级，不是值级：`dict ==` 忽略键序，而键序漂移照样把无关改动混进 diff。

        比的是**磁盘上的那份文本**（写盘格式：ensure_ascii=False + 2 空格缩进 + 末尾换行
        + 不排序键），所以这条同时钉住键序与数值表示。
        """
        path = _ROOT / "public" / "assets" / "data" / "prop_presets.json"
        on_disk = path.read_text(encoding="utf-8")
        m = _model()
        ed = PropPresetEditor(m)
        try:
            out = ed._staged()
            self.assertFalse(ed._dirty, "打开即脏是红线")
        finally:
            ed.deleteLater()
        self.assertEqual(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n",
            on_disk.replace("\r\n", "\n"),
            "打开→什么都不改→保存 改了字节",
        )

    def test_full_form_roundtrips_value_for_value(self) -> None:
        out = self._roundtrip({"torch": FULL_PRESET})
        self.assertEqual(out, {"torch": FULL_PRESET})
        # 键序也要对上（`dict ==` 忽略键序，单靠上一条查不出"整批键被挪到末尾"）
        self.assertEqual(json.dumps(out, ensure_ascii=False, indent=2),
                         json.dumps({"torch": FULL_PRESET}, ensure_ascii=False, indent=2))
        # 数值表示保真：int 不得漂成 float
        self.assertIsInstance(out["torch"]["rotation"], int)
        self.assertIsInstance(out["torch"]["light"]["intensity"], int)
        self.assertIsInstance(out["torch"]["light"]["flicker"]["hz"], int)

    def test_minimal_form_gains_no_phantom_keys(self) -> None:
        """新增可选键最容易出的错：打开一条只有 image 的老预设，保存后凭空多出
        light/particles/persistent/states —— 那是**改行为**，不是格式漂移。"""
        out = self._roundtrip({"x": {"image": _REAL_IMAGE}})
        self.assertEqual(out, {"x": {"image": _REAL_IMAGE}})
        for key in ("light", "particles", "persistent", "states", "defaultState", "lit"):
            self.assertNotIn(key, out["x"], f"最小形态凭空多出 {key}")

    def test_empty_entry_stays_empty(self) -> None:
        self.assertEqual(self._roundtrip({"y": {}}), {"y": {}})

    def test_explicit_empty_particles_list_is_preserved(self) -> None:
        """磁盘上显式写着 `particles: []` 的不能被抹掉（"等于缺省就删"会改字节）。"""
        out = self._roundtrip({"z": {"image": _REAL_IMAGE, "particles": []}})
        self.assertEqual(out["z"].get("particles"), [])

    def test_particle_mounts_roundtrip_with_odd_shapes(self) -> None:
        """粒子挂载往返：未知键 / 键序 / 坏条目 / 写坏的 point / int 表示都一字不改。"""
        src = {"m": {"image": _REAL_IMAGE, "particles": [
            {"point": [0, 1], "effect": "paper_money", "未来字段": 1},
            "junk",
            {"effect": "绝不存在的效果", "point": [0.5]},
            {"effect": ""},
        ], "states": {"s": {"particles": "坏"}, "t": {"particles": [{"effect": "paper_money"}]}}}}
        self.model.prop_presets = copy.deepcopy(src)
        ed = PropPresetEditor(self.model)
        try:
            ed._particles_block.ensure_built()
            ed._states_editor.ensure_built()
            for name in ("s", "t", "s"):
                ed._states_editor._on_select(name)
            out = ed._staged()
            self.assertFalse(ed._dirty)
        finally:
            ed.deleteLater()
        self.assertEqual(json.dumps(out, ensure_ascii=False), json.dumps(src, ensure_ascii=False))
        self.assertIsInstance(out["m"]["particles"][0]["point"][0], int)

    def test_legacy_vfx_key_passes_through_untouched(self) -> None:
        """旧 `vfx` 编辑器不再管，但数据里有就原样透传（校验器报 error 提醒迁移），绝不静默吞掉。"""
        src = {"old": {"image": _REAL_IMAGE, "vfx": ["paper_money"], "states": {"a": {"vfx": []}}}}
        self.assertEqual(self._roundtrip(src), src)

    def test_unknown_keys_pass_through(self) -> None:
        """将来给 PropPresetDef 加字段时，旧编辑器不得把它吞掉。"""
        src = {"w": {"image": _REAL_IMAGE, "未来字段": {"a": 1}}}
        self.assertEqual(self._roundtrip(src), src)

    def test_key_order_follows_disk(self) -> None:
        """原有键回原位置（numeric-roundtrip 契约 4）：不重排就是"一打开就改字节"。"""
        src = {"k": {"scale": 2, "image": _REAL_IMAGE, "label": "倒着写的"}}
        out = self._roundtrip(src)
        self.assertEqual(list(out["k"]), list(src["k"]))


class PropStateLightTristateTests(unittest.TestCase):
    """状态里的 `light` 必须是三态，不是两态。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()
        cls.model = _model()

    def _editor(self, states: dict, default: str = "") -> PropStatesEditor:
        ed = PropStatesEditor(self.model)
        ed.set_data(states, default)
        ed.ensure_built()
        return ed

    def test_three_modes_are_distinguishable(self) -> None:
        ed = self._editor({
            "a": {},                        # 不写 light 键 = 沿用基础块
            "b": {"light": None},           # 这个状态没有灯（火把灭了）
            "c": {"light": {"intensity": 1}},
        })
        try:
            for name, want in (("a", STATE_LIGHT_INHERIT),
                               ("b", STATE_LIGHT_NONE),
                               ("c", STATE_LIGHT_OWN)):
                ed._current = name
                ed._fill_detail()
                self.assertEqual(
                    ed._st_light._mode.currentData(), want,
                    f"状态 {name} 的档位判错了——null 与「没写」绝不能混")
        finally:
            ed.deleteLater()

    def test_each_mode_writes_the_right_shape(self) -> None:
        ed = self._editor({"a": {}, "b": {"light": None}, "c": {"light": {"intensity": 1}}})
        try:
            states, _default = ed.dump()
            self.assertNotIn("light", states["a"], "沿用档不该写 light 键")
            self.assertIn("light", states["b"])
            self.assertIsNone(states["b"]["light"], "「没有灯」必须写成 null")
            self.assertEqual(states["c"]["light"], {"intensity": 1})
        finally:
            ed.deleteLater()

    def test_switching_to_none_writes_null_not_missing(self) -> None:
        """从最外层入口改：把某状态切成「没有灯」，落盘必须是 null。"""
        ed = self._editor({"a": {}})
        try:
            ed._current = "a"
            ed._fill_detail()
            combo = ed._st_light._mode
            combo.setCurrentIndex(combo.findData(STATE_LIGHT_NONE))
            states, _ = ed.dump()
            self.assertIsNone(states["a"]["light"])
        finally:
            ed.deleteLater()

    def test_state_particles_are_inherit_or_own_list(self) -> None:
        """两态：不写键 = 沿用基础块；写了（哪怕空数组）= 整体替换。空数组与「没写」绝不能混。"""
        ed = self._editor({"a": {}, "b": {"particles": []},
                           "c": {"particles": [{"effect": "paper_money", "point": [0.5, 0.1]}]}})
        try:
            for name, want in (("a", STATE_PARTICLES_INHERIT), ("b", STATE_PARTICLES_OWN),
                               ("c", STATE_PARTICLES_OWN)):
                ed._on_select(name)
                self.assertEqual(ed._st_particles._mode.currentData(), want, name)
            states, _ = ed.dump()
            self.assertNotIn("particles", states["a"])
            self.assertEqual(states["b"]["particles"], [], "空数组 = 这个状态没有粒子，不是「没写」")
            self.assertEqual(states["c"]["particles"], [{"effect": "paper_money", "point": [0.5, 0.1]}])
        finally:
            ed.deleteLater()

    def test_switching_state_particles_to_own_writes_empty_list_then_inherit_drops_key(self) -> None:
        ed = self._editor({"a": {}})
        try:
            ed._on_select("a")
            combo = ed._st_particles._mode
            combo.setCurrentIndex(combo.findData(STATE_PARTICLES_OWN))
            states, _ = ed.dump()
            self.assertEqual(states["a"]["particles"], [])
            ed._st_particles._list._on_add()
            ed._st_particles._list._rows[0]["sel"].set_current("paper_money")
            ed._st_particles._list._rows[0]["sel"].value_changed.emit("paper_money")
            states, _ = ed.dump()
            self.assertEqual(states["a"]["particles"], [{"effect": "paper_money"}])
            combo.setCurrentIndex(combo.findData(STATE_PARTICLES_INHERIT))
            states, _ = ed.dump()
            self.assertNotIn("particles", states["a"])
        finally:
            ed.deleteLater()

    def test_commit_on_leave_keeps_the_edit(self) -> None:
        """切状态之前必须先提交 —— 不提交就是"填完点下一个，刚填的静默消失"。"""
        ed = self._editor({"a": {}, "b": {}})
        try:
            ed._current = "a"
            ed._fill_detail()
            ed._st_label.setText("点着")
            ed._on_select("b")          # 切走（commit-on-leave）
            states, _ = ed.dump()
            self.assertEqual(states["a"].get("label"), "点着")
        finally:
            ed.deleteLater()

    def test_dangling_default_state_is_kept_not_silently_cleared(self) -> None:
        """悬垂 defaultState 保值展示（共享控件保值契约），绝不顶替成第一项。"""
        ed = self._editor({"a": {}}, default="早就删掉的状态")
        try:
            _states, default = ed.dump()
            self.assertEqual(default, "早就删掉的状态")
        finally:
            ed.deleteLater()

    def test_reorder_moves_the_initial_state(self) -> None:
        """键序有语义：不写 defaultState 时运行时取第一个键 ⇒ 上下移必须真的改顺序。"""
        ed = self._editor({"a": {}, "b": {}})
        try:
            ed._current = "b"
            ed._move(-1)
            states, _ = ed.dump()
            self.assertEqual(list(states), ["b", "a"])
        finally:
            ed.deleteLater()

    def test_non_dict_state_entry_passes_through_untouched(self) -> None:
        """坏元素显式原样透传（不是当成一行正常数据去读控件）。"""
        ed = self._editor({"a": {}, "坏": None})
        try:
            states, _ = ed.dump()
            self.assertIsNone(states["坏"])
            self.assertEqual(list(states), ["a", "坏"], "有坏元素时按磁盘原序重建")
        finally:
            ed.deleteLater()


class PropPresetWidgetContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()
        cls.model = _model()

    def test_particle_effect_ids_are_not_bare_line_edits(self) -> None:
        """选择器铁律：效果 id 是跨文件引用，禁裸 QLineEdit，候选取自 id-provider。"""
        f = ParticleMountListField(self.model, None)
        f.set_mounts([{"effect": "paper_money"}])
        try:
            self.assertEqual(f.count(), 1)
            sel = f._rows[0]["sel"]
            self.assertIsInstance(sel, IdRefSelector)
            self.assertNotIsInstance(sel, QLineEdit)
            self.assertEqual(sel.current_id(), "paper_money")
            known = {rid for rid, _ in getattr(sel, "_items_normalized_cache", ())}
            self.assertTrue(known, "候选必须来自 ProjectModel.all_vfx_effect_ids()")
        finally:
            f.deleteLater()

    def test_dangling_particle_effect_id_is_preserved(self) -> None:
        f = ParticleMountListField(self.model, None)
        f.set_mounts([{"effect": "绝不存在的效果"}])
        try:
            self.assertEqual(f.to_list(), [{"effect": "绝不存在的效果"}])
        finally:
            f.deleteLater()

    def test_light_socket_is_a_selector_with_free_text(self) -> None:
        """灯挂点是引用字段（禁裸框），但取不到候选时必须仍能手打、且手打值保值。"""
        form = PropLightForm()
        try:
            self.assertIsInstance(form._socket, IdRefSelector)
            form.set_data({"intensity": 1, "socket": "谁也不认识的挂点"})
            self.assertEqual(form.dump().get("socket"), "谁也不认识的挂点")
        finally:
            form.deleteLater()

    def test_preview_state_dropdown_switches_the_previewed_image(self) -> None:
        """试挂预览的状态下拉：切状态就该看到那个状态的贴图（沿用口径同运行时）。"""
        self.model.prop_presets = {
            "torch": {
                "image": _REAL_IMAGE,
                "states": {"lit": {"image": "/resources/runtime/images/props/lit.png"},
                           "out": {}},
                "defaultState": "lit",
            },
        }
        ed = PropPresetEditor(self.model)
        try:
            combo = ed._state_combo
            self.assertGreaterEqual(combo.count(), 3, "基础块 + 两个状态")
            combo.setCurrentIndex(combo.findData("lit"))
            self.assertEqual(ed._preview_images()[0],
                             "/resources/runtime/images/props/lit.png")
            combo.setCurrentIndex(combo.findData("out"))
            self.assertEqual(ed._preview_images()[0], _REAL_IMAGE,
                             "状态没给图要回落基础块")
            self.assertFalse(ed._dirty, "切预览状态不是数据改动，绝不能标脏")
        finally:
            ed.deleteLater()

    def test_expanded_blocks_are_not_squeezed_flat(self) -> None:
        """布局塌陷：加进布局的控件没 show() / 中间层没 invalidate 就会被压成一条缝，
        而 model 层测试全绿也照样漏（只有量高度看得见）。"""
        self.model.prop_presets = {"torch": copy.deepcopy(FULL_PRESET)}
        ed = PropPresetEditor(self.model)
        try:
            for name, block in (("自带光源", ed._light_block), ("状态表", ed._states_editor)):
                block.ensure_built()
                body = block._body
                self.assertGreaterEqual(
                    body.sizeHint().height(), 40,
                    f"{name}块展开后高度只有 {body.sizeHint().height()}px —— 被压成一条缝了")
        finally:
            ed.deleteLater()


class HeldPropActionSurfaceTests(unittest.TestCase):
    """两个新动作 + `attachToSocket.state` 的登记面与往返。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()
        cls.model = _model()
        cls.model.prop_presets = {
            "torch": {
                "image": _REAL_IMAGE,
                "states": {"lit": {"label": "点着"}, "out": {"label": "灭"}},
                "defaultState": "lit",
            },
        }
        scenes = cls.model.all_scene_ids()
        cls.scene = scenes[0] if scenes else None

    def _roundtrip(self, act: dict) -> dict:
        ed = ActionEditor("t")
        ed.set_project_context(self.model, self.scene)
        ed.set_data([act])
        try:
            out = ed.to_list()
            self.assertEqual(len(out), 1)
            return out[0]
        finally:
            ed.deleteLater()

    def test_registered_on_every_editor_surface(self) -> None:
        for t in ("setPropState", "fadeLight"):
            self.assertIn(t, ACTION_TYPES)
            self.assertIn(t, ACTION_PERSISTENCE, "新增 ACTION_TYPES 必须同步持久化分类")

    def test_minimal_forms_gain_no_phantom_keys(self) -> None:
        """`fadeMs` / `state` 缺省不写键（作用域剔除表）。"""
        a = {"type": "setPropState",
             "params": {"target": "player", "socket": "right_hand", "state": "out"}}
        self.assertEqual(self._roundtrip(a), a)
        b = {"type": "fadeLight", "params": {"lightId": "door_lantern", "scale": 0}}
        self.assertEqual(self._roundtrip(b), b)
        c = {"type": "attachToSocket",
             "params": {"target": "player", "socket": "right_hand", "prop": "torch"}}
        self.assertEqual(self._roundtrip(c), c)

    def test_filled_forms_roundtrip(self) -> None:
        for act in (
            {"type": "setPropState",
             "params": {"target": "player", "socket": "right_hand", "state": "lit",
                        "fadeMs": 400}},
            {"type": "fadeLight",
             "params": {"lightId": "door_lantern", "scale": 0.5, "fadeMs": 1200}},
            {"type": "attachToSocket",
             "params": {"target": "player", "socket": "right_hand", "prop": "torch",
                        "state": "lit"}},
        ):
            with self.subTest(act["type"]):
                self.assertEqual(self._roundtrip(act), act)

    def test_scale_zero_stays_int_zero(self) -> None:
        """`scale: 0`（吹灭）过一趟 QDoubleSpinBox 不得漂成 `0.0`。"""
        out = self._roundtrip({"type": "fadeLight",
                               "params": {"lightId": "l", "scale": 0}})
        self.assertIsInstance(out["params"]["scale"], int)

    def test_no_bare_line_edit_on_new_params(self) -> None:
        for act_type, params in (
            ("setPropState", {"target": "", "socket": "", "state": ""}),
            ("fadeLight", {"lightId": "", "scale": 0}),
            ("attachToSocket", {"target": "", "socket": "", "prop": "torch", "state": ""}),
        ):
            row = ActionRow({"type": act_type, "params": params},
                            model=self.model, scene_id=self.scene)
            try:
                for name, w in row._param_widgets.items():
                    self.assertIsNot(
                        type(w), QLineEdit,
                        f"{act_type}.{name} 是裸 QLineEdit（违选择器铁律）")
            finally:
                row.deleteLater()

    def test_attach_state_candidates_come_from_the_prop(self) -> None:
        row = ActionRow(
            {"type": "attachToSocket",
             "params": {"target": "player", "socket": "h", "prop": "torch"}},
            model=self.model, scene_id=self.scene)
        try:
            w = row._param_widgets["state"]
            self.assertIsInstance(w, FilterableTypeCombo)
            values = {v for _lab, v in w._entries}
            self.assertTrue({"lit", "out"} <= values,
                            f"候选没从 prop 的 states 派生：{sorted(values)}")
        finally:
            row.deleteLater()

    def test_attach_state_unknown_value_is_kept(self) -> None:
        """换 prop 之后旧状态名不在新预设里是常态 —— 静默清空就是改行为。"""
        act = {"type": "attachToSocket",
               "params": {"target": "player", "socket": "h", "prop": "torch",
                          "state": "早就删掉的状态"}}
        self.assertEqual(self._roundtrip(act), act)

    def test_set_prop_state_socket_candidates_come_from_the_target(self) -> None:
        row = ActionRow(
            {"type": "setPropState",
             "params": {"target": "player", "socket": "", "state": "lit"}},
            model=self.model, scene_id=self.scene)
        try:
            w = row._param_widgets["socket"]
            self.assertIsInstance(w, FilterableTypeCombo)
            expect = {n for n, _l in (self.model.socket_names_for_actor(self.scene, "player") or [])}
            got = {v for _lab, v in w._entries}
            self.assertTrue(expect <= got,
                            f"socket 候选没从 player 的动画包派生：{sorted(got)}")
        finally:
            row.deleteLater()

    def test_dangling_light_id_is_preserved(self) -> None:
        act = {"type": "fadeLight", "params": {"lightId": "绝不存在的灯", "scale": 1}}
        self.assertEqual(self._roundtrip(act), act)

    def test_scene_light_provider_lists_follow_and_phase(self) -> None:
        m = self.model
        m.scenes["__灯表探针"] = {
            "lighting": {"lights": [
                {"id": "a", "kind": "point", "phases": ["夜"]},
                {"id": "b", "kind": "point", "follow": {"target": "player"}},
                {"kind": "point"},  # 没 id：不该出现在候选里
            ]},
        }
        try:
            rows = m.scene_light_ids_for_scene("__灯表探针")
            self.assertEqual([r[0] for r in rows], ["a", "b"])
            self.assertIn("夜", rows[0][1])
            self.assertIn("跟随 player", rows[1][1])
        finally:
            m.scenes.pop("__灯表探针", None)


class SceneLightFollowRefactorTests(unittest.TestCase):
    """场景灯 `follow.target`：长在数据结构里的实体引用，走单写的改写函数。"""

    def _model_with(self) -> ProjectModel:
        m = ProjectModel()
        m.load_project(_ROOT)
        m.scenes["__甲"] = {
            "npcs": [{"id": "更夫", "x": 0, "y": 0}],
            "lighting": {"lights": [
                {"id": "灯笼", "kind": "point", "intensity": 1,
                 "follow": {"target": "更夫", "socket": "right_hand"}},
                {"id": "别的灯", "kind": "point", "intensity": 1},
            ]},
        }
        m.scenes["__乙"] = {"npcs": [], "lighting": {"lights": []}}
        return m

    @staticmethod
    def _follow_target(m: ProjectModel, scene: str, light_id: str) -> object:
        for l in m.scenes[scene]["lighting"]["lights"]:
            if l.get("id") == light_id:
                return (l.get("follow") or {}).get("target")
        return None

    def test_scan_names_the_light(self) -> None:
        from tools.editor.shared.entity_refactor import scan_entity_usages
        m = self._model_with()
        report = scan_entity_usages(m, "__甲", "npc", "更夫")
        hits = report["sceneLightFollows"]
        self.assertEqual([h["itemId"] for h in hits], ["灯笼"],
                         "扫描必须给到灯粒度，弹窗要说得出是哪盏灯跟着它")
        self.assertGreaterEqual(report["totalRefs"], 1)

    def test_rename_follows_mechanically(self) -> None:
        from tools.editor.shared.entity_refactor import rename_entity
        m = self._model_with()
        out = rename_entity(m, "__甲", "npc", "更夫", "打更人")
        self.assertEqual(out["counts"]["sceneLightFollowsRewritten"], 1)
        self.assertEqual(self._follow_target(m, "__甲", "灯笼"), "打更人")

    def test_rename_undo_puts_it_back(self) -> None:
        from tools.editor.shared.entity_refactor import (
            push_journal, rename_entity, undo_last,
        )
        m = self._model_with()
        push_journal(m, rename_entity(m, "__甲", "npc", "更夫", "打更人"))
        res = undo_last(m)
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(self._follow_target(m, "__甲", "灯笼"), "更夫")

    def test_move_reports_but_does_not_rewrite(self) -> None:
        """灯是源场景的家具，跟不着实体换场景去 —— 静默改写等于替作者瞎猜。"""
        from tools.editor.shared.entity_refactor import move_entity
        m = self._model_with()
        out = move_entity(m, "__甲", "npc", "更夫", "__乙")
        self.assertEqual([h["itemId"] for h in out["sceneLightFollows"]], ["灯笼"])
        self.assertEqual(self._follow_target(m, "__甲", "灯笼"), "更夫",
                         "move 不该动 follow.target")

    def test_scene_light_follow_move_then_undo_is_byte_identical(self) -> None:
        from tools.editor.shared.entity_refactor import (
            move_entity, push_journal, undo_last,
        )
        m = self._model_with()
        before = json.dumps(m.scenes["__甲"]["lighting"], ensure_ascii=False, sort_keys=True)
        push_journal(m, move_entity(m, "__甲", "npc", "更夫", "__乙"))
        res = undo_last(m)
        self.assertTrue(res.get("ok"), res)
        after = json.dumps(m.scenes["__甲"]["lighting"], ensure_ascii=False, sort_keys=True)
        self.assertEqual(before, after, "撤销迁移不得反向「修」一处从未被改过的引用")

    def test_only_npc_kind_is_a_follow_target(self) -> None:
        """热点 / zone 解析不出接触点（Game.entityContactOf 只认 player 与 NPC）。"""
        from tools.editor.shared.entity_refactor import _rewrite_scene_light_follow_targets
        m = self._model_with()
        for kind in ("hotspot", "zone", "spawn"):
            self.assertEqual(
                _rewrite_scene_light_follow_targets(m, kind, "__甲", "更夫", "__甲", "x"), 0)
        self.assertEqual(self._follow_target(m, "__甲", "灯笼"), "更夫")

    def test_set_prop_state_target_is_a_registered_entity_ref(self) -> None:
        from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
        self.assertEqual(ENTITY_REF_PARAMS["setPropState"], {"target": "actor"})


class PropPresetValidationTests(unittest.TestCase):
    """每条护栏先把数据改坏一次，确认它真的红。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.model = _model()

    def _issues(self, table: dict) -> list:
        from tools.editor.validator import _validate_prop_presets
        self.model.prop_presets = copy.deepcopy(table)
        out: list = []
        _validate_prop_presets(self.model, out)
        return out

    @staticmethod
    def _errors(issues: list) -> list[str]:
        return [i.message for i in issues if i.severity == "error"]

    def test_healthy_full_preset_is_clean(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["particles"] = []
        self.assertEqual(self._issues({"torch": table}), [])

    def test_real_project_table_is_clean(self) -> None:
        """棘轮：现网数据不得因为这段新校验多出任何一条。"""
        m = _model()
        from tools.editor.validator import _validate_prop_presets
        out: list = []
        _validate_prop_presets(m, out)
        self.assertEqual(out, [])

    def test_non_positive_intensity_is_an_error(self) -> None:
        for bad in (0, -1, "2", None, True):
            table = copy.deepcopy(FULL_PRESET)
            table["light"]["intensity"] = bad
            with self.subTest(bad=bad):
                self.assertTrue(
                    any("intensity" in m for m in self._errors(self._issues({"t": table}))),
                    f"intensity={bad!r} 应报 error（运行时把整盏灯丢掉）")

    def test_half_configured_flicker_is_an_error(self) -> None:
        for flk in ({"amp": 0.2}, {"hz": 8}, {"amp": 0, "hz": 8}, {"amp": 0.2, "hz": -1}):
            table = copy.deepcopy(FULL_PRESET)
            table["light"]["flicker"] = flk
            with self.subTest(flk=flk):
                self.assertTrue(
                    any("flicker" in m for m in self._errors(self._issues({"t": table}))),
                    f"flicker={flk!r} 应报 error（运行时把整块 flicker 丢掉）")

    def test_full_flicker_is_clean(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["light"]["flicker"] = {"amp": 0.2, "hz": 8}
        self.assertEqual(self._errors(self._issues({"t": table})), [])

    def test_missing_particle_effect_asset_is_an_error(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["particles"] = [{"effect": "绝不存在的效果"}]
        msgs = self._errors(self._issues({"t": table}))
        self.assertTrue(any("绝不存在的效果" in m for m in msgs), msgs)

    def test_missing_particle_effect_asset_in_a_state_is_an_error(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["states"]["lit"]["particles"] = [{"effect": "绝不存在的效果"}]
        msgs = self._errors(self._issues({"t": table}))
        self.assertTrue(any("states[lit].particles[0].effect" in m for m in msgs), msgs)

    def test_legacy_vfx_is_an_error_on_base_and_state(self) -> None:
        """契约 v3：`vfx` 已由 particles 取代，写了运行时不读——那团效果根本不放，只有这里能看见。"""
        for where in ("base", "state"):
            table = copy.deepcopy(FULL_PRESET)
            (table if where == "base" else table["states"]["lit"])["vfx"] = ["paper_money"]
            with self.subTest(where=where):
                msgs = self._errors(self._issues({"t": table}))
                self.assertTrue(any("已由 particles 取代，写了运行时不读" in m for m in msgs), msgs)

    def test_particle_mount_bad_shapes_are_errors(self) -> None:
        for bad, needle in (
            ("paper_money", "particles 须为数组"),
            (["paper_money"], "particles[0] 须为对象"),
            ([{"effect": ""}], "particles[0].effect"),
            ([{"effect": 3}], "particles[0].effect"),
            ([{"point": [0.5, 0.1]}], "particles[0].effect"),
            ([{"effect": "paper_money", "point": [0.5]}], "particles[0].point"),
            ([{"effect": "paper_money", "point": "杆头"}], "particles[0].point"),
        ):
            for where in ("base", "state"):
                table = copy.deepcopy(FULL_PRESET)
                (table if where == "base" else table["states"]["lit"])["particles"] = bad
                with self.subTest(bad=bad, where=where):
                    msgs = self._errors(self._issues({"t": table}))
                    self.assertTrue(any(needle in m for m in msgs), msgs)

    def test_particle_mount_valid_shapes_are_clean(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["particles"] = [{"effect": "paper_money", "point": [0.5, 0.05]}, {"effect": "paper_money"}]
        table["states"]["out"]["particles"] = []
        table["states"]["lit"]["particles"] = [{"effect": "paper_money", "point": None}]
        self.assertEqual(self._issues({"t": table}), [])
        table["particles"][0]["point"] = [3, -1]      # 越界：运行时夹 0..1 ⇒ 只提醒
        issues = self._issues({"t": table})
        self.assertEqual([i.message for i in issues if i.severity == "error"], [])
        self.assertTrue(any("particles[0].point" in i.message for i in issues if i.severity == "warning"))

    def test_default_state_must_exist(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["defaultState"] = "没有这个状态"
        msgs = self._errors(self._issues({"t": table}))
        self.assertTrue(any("defaultState" in m for m in msgs), msgs)

    def test_default_state_without_states_is_an_error(self) -> None:
        msgs = self._errors(self._issues({"t": {"image": _REAL_IMAGE,
                                                "defaultState": "lit"}}))
        self.assertTrue(any("defaultState" in m for m in msgs), msgs)

    def test_missing_image_file_is_an_error(self) -> None:
        table = {"t": {"image": "/resources/runtime/images/props/根本没有这张图.png"}}
        msgs = self._errors(self._issues(table))
        self.assertTrue(any("不存在" in m for m in msgs), msgs)

    def test_missing_state_image_file_is_an_error(self) -> None:
        table = {"t": {"image": _REAL_IMAGE,
                       "states": {"lit": {"image": "/resources/runtime/images/props/没有.png"}},
                       "defaultState": "lit"}}
        msgs = self._errors(self._issues(table))
        self.assertTrue(any("states[lit].image" in m for m in msgs), msgs)

    def test_state_light_null_is_not_an_error(self) -> None:
        """`light: null` 是有意义的值（这个状态没有灯），不是坏数据。"""
        table = {"t": {"image": _REAL_IMAGE,
                       "states": {"out": {"light": None}}, "defaultState": "out"}}
        self.assertEqual(self._errors(self._issues(table)), [])

    def test_non_bool_persistent_is_an_error(self) -> None:
        table = {"t": {"image": _REAL_IMAGE, "persistent": "true"}}
        msgs = self._errors(self._issues(table))
        self.assertTrue(any("persistent" in m for m in msgs), msgs)

    def test_bad_offset_shape_is_an_error(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["light"]["offset"] = [0, 10]
        msgs = self._errors(self._issues({"t": table}))
        self.assertTrue(any("offset" in m for m in msgs), msgs)


_FLAME_SHEET = "/resources/runtime/images/ui/three_fires_sheet.png"

#: 燃烧物（火把）形态：基础块起火点 + 火苗 + burn，状态覆盖 burn / 起火点 + 进入动作。
FIRE_PRESET = {
    "label": "火把",
    "image": _REAL_IMAGE,
    "anchorX": 0.5,
    "anchorY": 0.9,
    "firePoint": [0.5, 0.05],
    "flame": {"image": _FLAME_SHEET, "cols": 12, "frames": 64, "fps": 24, "height": 30},
    "burn": 1,
    "windShelter": 0,
    "states": {
        "lit": {"burn": 1},
        "guarding": {"burn": 0.75, "windShelter": 0.8},
        "ember": {"burn": 0.15, "firePoint": [0.4, 0.1]},
        "out": {"burn": 0, "onEnterActions": [
            {"type": "playSfx", "params": {"id": "sfx_rock_bounce_dry"}}]},
    },
    "defaultState": "lit",
}


class FlamePresetValidationTests(unittest.TestCase):
    """燃烧物字段：每条护栏先把数据改坏一次，确认它真的红。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.model = _model()

    def _issues(self, entry: dict) -> list:
        from tools.editor.validator import _validate_prop_presets
        self.model.prop_presets = {"t": copy.deepcopy(entry)}
        out: list = []
        _validate_prop_presets(self.model, out)
        return out

    def _errors(self, entry: dict) -> list[str]:
        return [i.message for i in self._issues(entry) if i.severity == "error"]

    def _warnings(self, entry: dict) -> list[str]:
        return [i.message for i in self._issues(entry) if i.severity == "warning"]

    def test_healthy_fire_preset_is_clean(self) -> None:
        self.assertEqual([i.message for i in self._issues(FIRE_PRESET)], [])

    def test_lantern_without_fire_fields_is_clean(self) -> None:
        self.assertEqual(self._issues({"image": _REAL_IMAGE}), [])

    def test_bad_fire_point_shape_is_an_error(self) -> None:
        for bad in ([0.5], "0.5,0.1", [0.5, "左"], [float("nan"), 0.1], {"x": 0.5}, [0.5, {}]):
            for where in ("base", "state"):
                e = copy.deepcopy(FIRE_PRESET)
                if where == "base":
                    e["firePoint"] = bad
                else:
                    e["states"]["ember"]["firePoint"] = bad
                with self.subTest(bad=bad, where=where):
                    msgs = self._errors(e)
                    self.assertTrue(any("firePoint" in m for m in msgs), msgs)

    def test_out_of_range_fire_point_is_only_a_warning(self) -> None:
        """运行时夹到 0..1（合法数据，只是被钉到边上）⇒ warning，不比 TS 更严。"""
        e = copy.deepcopy(FIRE_PRESET)
        e["firePoint"] = [2, -1]
        self.assertEqual(self._errors(e), [])
        self.assertTrue(any("firePoint" in m for m in self._warnings(e)))

    def test_fire_point_extra_elements_are_legal(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["firePoint"] = [0.5, 0.05, 9]
        self.assertEqual(self._issues(e), [])

    def test_non_numeric_burn_is_an_error_and_out_of_range_warns(self) -> None:
        for bad in ("满", float("inf"), {"v": 1}, [1, 2]):
            e = copy.deepcopy(FIRE_PRESET)
            e["states"]["out"]["burn"] = bad
            with self.subTest(bad=bad):
                self.assertTrue(any("burn" in m for m in self._errors(e)))
        e = copy.deepcopy(FIRE_PRESET)
        e["burn"] = 1.5
        self.assertEqual(self._errors(e), [])
        self.assertTrue(any("burn" in m for m in self._warnings(e)))

    def test_wind_shelter_gets_the_same_checks_as_burn(self) -> None:
        """挡风比例与 burn 同一个运行时清洗（`parseBurn`）⇒ 同一套护栏，基础块与状态两处都查。"""
        for where in ("base", "state"):
            def put(val, where=where):
                e = copy.deepcopy(FIRE_PRESET)
                (e if where == "base" else e["states"]["guarding"])["windShelter"] = val
                return e
            for bad in ("挡", float("inf"), {"v": 1}, [1, 2]):
                with self.subTest(where=where, bad=bad):
                    msgs = self._errors(put(bad))
                    self.assertTrue(any("windShelter" in m and "不挡风" in m for m in msgs), msgs)
            with self.subTest(where=where, case="越界只提醒"):
                e = put(1.8)
                self.assertEqual(self._errors(e), [])
                self.assertTrue(any("windShelter" in m and "夹到" in m for m in self._warnings(e)))
            with self.subTest(where=where, case="强转只提醒"):
                e = put("0.8")
                self.assertEqual(self._errors(e), [])
                self.assertTrue(any("windShelter" in m and "Number()" in m for m in self._warnings(e)))
            with self.subTest(where=where, case="null=0"):
                e = put(None)
                self.assertEqual(self._errors(e), [])
                self.assertTrue(any("windShelter" in m and "挡风比例 0" in m for m in self._warnings(e)))

    def test_number_coercible_values_are_legal_but_warned(self) -> None:
        """TS `finiteOrUndefined` 是 `Number(v)`：`"0.5"` / `true` / `null` 都是合法数据——
        报 error 就比运行时更严（norms 不变量 7），只提醒；`null` 尤其要说清是 0（火灭）。"""
        cases = (
            (("burn",), "0.5"),
            (("states", "out", "burn"), True),
            (("firePoint",), ["0.5", 0.05]),
            (("flame", "height"), "30"),
            (("flame", "cols"), "12"),
            (("flame", "fps"), "24"),
        )
        for path, val in cases:
            e = copy.deepcopy(FIRE_PRESET)
            node = e
            for k in path[:-1]:
                node = node[k]
            node[path[-1]] = val
            with self.subTest(path=path, val=val):
                self.assertEqual(self._errors(e), [])
                self.assertTrue(any("Number()" in m for m in self._warnings(e)), self._warnings(e))
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["lit"]["burn"] = None
        self.assertEqual(self._errors(e), [])
        self.assertTrue(any("Number(null)=0" in m for m in self._warnings(e)))

    def test_flame_voiding_fields_are_errors(self) -> None:
        for patch, needle in (
            ({"image": ""}, "flame.image"),
            ({"image": 3}, "flame.image"),
            ({"height": 0}, "flame.height"),
            ({"height": -3}, "flame.height"),
            ({"height": "三十"}, "flame.height"),
            ({"height": None}, "flame.height"),
            ({"cols": 0}, "flame.cols"),
            ({"cols": None}, "flame.cols"),
            ({"frames": "六十四"}, "flame.frames"),
            ({"fps": -3}, "flame.fps"),
        ):
            e = copy.deepcopy(FIRE_PRESET)
            e["flame"].update(patch)
            with self.subTest(patch=patch):
                msgs = self._errors(e)
                self.assertTrue(any(needle in m for m in msgs), msgs)
        e = copy.deepcopy(FIRE_PRESET)
        del e["flame"]["height"]
        self.assertTrue(any("flame.height" in m for m in self._errors(e)))
        e = copy.deepcopy(FIRE_PRESET)
        e["flame"] = "三把火"
        self.assertTrue(any("flame" in m for m in self._errors(e)))

    def test_flame_image_file_must_exist(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["flame"]["image"] = "/resources/runtime/images/ui/根本没有的火.png"
        msgs = self._errors(e)
        self.assertTrue(any("flame.image" in m and "不存在" in m for m in msgs), msgs)

    def test_non_integer_cols_warns(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["flame"]["cols"] = 12.5
        self.assertEqual(self._errors(e), [])
        self.assertTrue(any("flame.cols" in m for m in self._warnings(e)))

    def test_flame_in_a_state_is_ignored_and_warned(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["ember"]["flame"] = {"image": _FLAME_SHEET, "height": 10}
        self.assertTrue(any("states[ember].flame" in m for m in self._warnings(e)))

    def test_base_on_enter_actions_is_ignored_and_warned(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["onEnterActions"] = [{"type": "playSfx", "params": {"id": "sfx_rock_bounce_dry"}}]
        self.assertTrue(any("onEnterActions" in m for m in self._warnings(e)))

    def test_on_enter_actions_go_through_the_action_checker(self) -> None:
        """与物件 `use.actions` 同一条动作校验链：未登记动作、嵌套里的未登记动作都要报。"""
        for acts in (
            [{"type": "__definitely_not_registered__", "params": {}}],
            [{"type": "runActionsIf", "params": {
                "condition": {"flag": "x"},
                "actions": [],
                "elseActions": [{"type": "__definitely_not_registered__", "params": {}}]}}],
        ):
            e = copy.deepcopy(FIRE_PRESET)
            e["states"]["out"]["onEnterActions"] = acts
            with self.subTest(acts=acts):
                msgs = self._errors(e)
                self.assertTrue(any("__definitely_not_registered__" in m for m in msgs), msgs)

    def test_on_enter_actions_prop_state_refs_are_checked(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["out"]["onEnterActions"] = [{"type": "setPropState", "params": {
            "target": "player", "socket": "right_hand", "state": "根本没这个状态"}}]
        msgs = self._errors(e)
        self.assertTrue(any("根本没这个状态" in m for m in msgs), msgs)

    def test_on_enter_actions_shape_errors(self) -> None:
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["out"]["onEnterActions"] = {"type": "playSfx"}
        self.assertTrue(any("onEnterActions" in m for m in self._errors(e)))
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["out"]["onEnterActions"] = ["playSfx"]
        self.assertTrue(any("onEnterActions[0]" in m for m in self._errors(e)))

    def test_cutscene_allowlist_gate_is_dormant_while_switch_actions_are_not_allowed(self) -> None:
        from tools.editor import validator as v
        self.assertFalse(v._CUTSCENE_ACTION_WHITELIST & {"setPropState", "attachToSocket"},
                         "契约前提：两个切状态动作目前都不在过场白名单里——变了就改这条用例")
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["out"]["onEnterActions"] = [
            {"type": "giveItem", "params": {"id": "__x__", "count": 1}}]
        self.assertFalse(any("过场白名单" in m for m in self._errors(e)))

    def test_cutscene_allowlist_gate_fires_once_switch_is_allowed(self) -> None:
        from unittest import mock

        from tools.editor import validator as v
        allowed = v._CUTSCENE_ACTION_WHITELIST | {"setPropState"}
        e = copy.deepcopy(FIRE_PRESET)
        e["states"]["out"]["onEnterActions"] = [
            {"type": "playSfx", "params": {"id": "sfx_rock_bounce_dry"}},
            {"type": "runActions", "params": {"actions": [
                {"type": "giveItem", "params": {"id": "__x__", "count": 1}}]}},
        ]
        with mock.patch.object(v, "_CUTSCENE_ACTION_WHITELIST", allowed):
            msgs = [m for m in self._errors(e) if "过场白名单" in m]
        self.assertTrue(any("giveItem" in m for m in msgs), msgs)
        self.assertTrue(any("runActions" in m for m in msgs), msgs)
        self.assertFalse(any("'playSfx'" in m for m in msgs), "白名单内的动作不报")


class FlamePresetEditorTests(unittest.TestCase):
    """挂件预设页的「火焰」块 + 状态里的起火点 / burn / 进入时动作 + 试挂预览里的起火点与火苗。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()
        cls.model = _model()

    def _editor(self, table: dict, select: str = "t") -> PropPresetEditor:
        self.model.prop_presets = copy.deepcopy(table)
        self.model._dirty.clear()
        ed = PropPresetEditor(self.model)
        self.addCleanup(ed.deleteLater)
        ed._refresh(keep=select)
        ed._canvas.resize(340, 400)
        return ed

    @staticmethod
    def _dumps(obj: object) -> str:
        return json.dumps(obj, ensure_ascii=False, indent=2)

    # ---- 往返 ----------------------------------------------------------

    def test_full_fire_preset_roundtrips_byte_for_byte(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        out = ed._staged()
        self.assertFalse(ed._dirty, "打开即脏是红线")
        self.assertEqual(self._dumps(out), self._dumps({"t": FIRE_PRESET}))
        self.assertIsInstance(out["t"]["flame"]["cols"], int)
        self.assertIsInstance(out["t"]["flame"]["height"], int)
        self.assertIsInstance(out["t"]["burn"], int)
        self.assertIsInstance(out["t"]["windShelter"], int)
        ed._fire_block.ensure_built()
        ed._states_editor._on_select("out")      # 让进入动作真的过一趟 ActionEditor
        ed._states_editor._on_select("guarding")  # 挡风覆盖过一趟 OptionalNumField
        ed._states_editor._on_select("ember")
        self.assertEqual(self._dumps(ed._staged()), self._dumps({"t": FIRE_PRESET}))

    def test_bad_and_odd_values_roundtrip_untouched(self) -> None:
        """运行时自己清洗的坏值 / 越界值 / 未来键，打开→不动→保存都要一字不改。"""
        odd = {
            "image": _REAL_IMAGE,
            "firePoint": [2, -1, 9],
            "burn": "1",
            "windShelter": 1.8,
            "flame": {"height": 0, "image": 3, "cols": 12.5, "未来字段": {"a": 1}},
            "states": {
                "a": {"firePoint": None, "burn": 1.5, "windShelter": "x", "onEnterActions": "不是数组"},
                "b": {"onEnterActions": [
                    {"type": "setPropState", "params": {"target": "player", "state": "a"}},
                    "坏元素",
                ]},
            },
        }
        ed = self._editor({"t": odd})
        ed._fire_block.ensure_built()
        for name in ("a", "b", "a"):
            ed._states_editor._on_select(name)
        self.assertEqual(self._dumps(ed._staged()), self._dumps({"t": odd}))
        ed.flush_to_model(True)
        self.assertNotIn("prop_presets", self.model._dirty, "零编辑 flush 不标脏")

    def test_non_dict_flame_passes_through(self) -> None:
        ed = self._editor({"t": {"image": _REAL_IMAGE, "flame": "三把火"}})
        self.assertEqual(ed._staged()["t"]["flame"], "三把火")

    def test_minimal_preset_gains_no_fire_keys(self) -> None:
        ed = self._editor({"t": {"image": _REAL_IMAGE, "states": {"lit": {}}}})
        ed._fire_block.ensure_built()
        out = ed._staged()["t"]
        for key in ("firePoint", "flame", "burn", "windShelter"):
            self.assertNotIn(key, out)
        self.assertEqual(out["states"], {"lit": {}},
                         "状态也不许凭空多出 firePoint/burn/windShelter/onEnterActions")

    def test_fire_block_starts_collapsed_and_lazy_without_fire_keys(self) -> None:
        ed = self._editor({"t": {"image": _REAL_IMAGE}})
        self.assertFalse(ed._fire_block._built, "没配火的挂件不该造火焰控件（懒建）")
        self.assertFalse(ed._fire_block._section.is_expanded())
        ed2 = self._editor({"t": FIRE_PRESET})
        self.assertTrue(ed2._fire_block._section.is_expanded(), "配了火就当场展开，折着等于没接进来")

    # ---- 真实编辑 ------------------------------------------------------

    def test_turning_flame_on_writes_visible_defaults_and_marks_dirty(self) -> None:
        ed = self._editor({"t": {"image": _REAL_IMAGE}})
        ed._fire_block.ensure_built()
        ed._fire_block._flame_on.setChecked(True)
        self.assertTrue(ed._dirty)
        ed.flush_to_model(True)
        self.assertIn("prop_presets", self.model._dirty)
        flame = self.model.prop_presets["t"]["flame"]
        self.assertEqual(flame["image"], _FLAME_SHEET)
        self.assertGreater(flame["height"], 0, "勾上就得是运行时画得出来的火苗")
        self.assertEqual((flame["cols"], flame["frames"]), (12, 64), "三把火图集要按 12 列 64 帧切")
        self.assertIsInstance(flame["cols"], int)

    def test_state_burn_and_fire_point_edits_are_written(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        se = ed._states_editor
        se._on_select("lit")
        se._st_burn._spin.setValue(0.5)
        se._st_fire._on.setChecked(True)
        se._st_fire._spins[0].setValue(0.25)
        se._on_select("ember")                   # commit-on-leave
        ed.flush_to_model(True)
        lit = self.model.prop_presets["t"]["states"]["lit"]
        self.assertEqual(lit["burn"], 0.5)
        self.assertEqual(lit["firePoint"][0], 0.25)

    def test_wind_shelter_edits_are_written_base_and_state(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        se = ed._states_editor
        se._on_select("guarding")
        se._st_wind_shelter._spin.setValue(0.5)
        se._on_select("lit")
        se._st_wind_shelter._on.setChecked(True)
        se._st_wind_shelter._spin.setValue(0.25)
        se._on_select("ember")                   # commit-on-leave
        ed._fire_block._wind_shelter._spin.setValue(0.1)
        self.assertTrue(ed._dirty)
        ed.flush_to_model(True)
        t = self.model.prop_presets["t"]
        self.assertEqual(t["windShelter"], 0.1)
        self.assertEqual(t["states"]["guarding"]["windShelter"], 0.5)
        self.assertEqual(t["states"]["lit"]["windShelter"], 0.25)
        self.assertNotIn("windShelter", t["states"]["ember"], "没勾的状态不写键（沿用基础块）")
        self.assertNotIn("windShelter", t.get("light") or {}, "挡风不碰灯")

    def test_unchecking_state_wind_shelter_removes_the_key(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        se = ed._states_editor
        se._on_select("guarding")
        se._st_wind_shelter._on.setChecked(False)
        se._on_select("lit")
        ed.flush_to_model(True)
        self.assertNotIn("windShelter", self.model.prop_presets["t"]["states"]["guarding"])

    def test_wind_shelter_fields_explain_guarding_and_not_the_light(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        for tip in (ed._fire_block._wind_shelter.toolTip(),
                    ed._states_editor._st_wind_shelter.toolTip()):
            self.assertIn("护火", tip)
            self.assertIn("不改灯", tip)

    def test_adding_an_on_enter_action_from_the_button(self) -> None:
        from PySide6.QtWidgets import QPushButton
        ed = self._editor({"t": FIRE_PRESET})
        se = ed._states_editor
        se._on_select("lit")
        add = [b for b in se._st_on_enter.findChildren(QPushButton) if b.text() == "+ 进入时动作"]
        self.assertEqual(len(add), 1)
        add[0].click()
        ed.flush_to_model(True)
        acts = self.model.prop_presets["t"]["states"]["lit"].get("onEnterActions")
        self.assertIsInstance(acts, list)
        self.assertEqual(len(acts), 1)

    def test_on_enter_actions_uses_the_shared_action_editor(self) -> None:
        from tools.editor.shared.action_editor import ActionEditor as _AE
        ed = self._editor({"t": FIRE_PRESET})
        self.assertIsInstance(ed._states_editor._st_on_enter, _AE, "选择器铁律：与物件用途同款动作列表")
        self.assertIs(ed._states_editor._st_on_enter._ctx_model, self.model)

    # ---- 试挂预览 ------------------------------------------------------

    def _need_geometry(self, ed: PropPresetEditor) -> None:
        if ed._canvas._fire_geometry() is None or ed._prop_pix is None:
            self.skipTest("工程里没有可试挂的动画包挂点标注")

    def test_flame_is_drawn_bottom_center_at_the_fire_point(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        self._need_geometry(ed)
        fire = ed._canvas.fire_view_point()
        rect = ed._canvas.flame_view_rect()
        self.assertIsNotNone(fire)
        self.assertIsNotNone(rect, "有火苗、burn>0 就得画出来")
        self.assertAlmostEqual(rect.center().x(), fire.x(), places=6)
        self.assertAlmostEqual(rect.bottom(), fire.y(), places=6)

    def test_state_dropdown_changes_the_flame_size(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        self._need_geometry(ed)
        combo = ed._state_combo
        heights = {}
        for name in ("lit", "ember", "out"):
            combo.setCurrentIndex(combo.findData(name))
            rect = ed._canvas.flame_view_rect()
            heights[name] = rect.height() if rect is not None else 0.0
        self.assertGreater(heights["lit"], 0)
        self.assertAlmostEqual(heights["ember"] / heights["lit"], 0.15, places=6)
        self.assertEqual(heights["out"], 0.0, "burn=0 火苗不画")
        self.assertFalse(ed._dirty, "切预览状态不是数据改动")

    def test_ember_state_moves_the_fire_point(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        self._need_geometry(ed)
        combo = ed._state_combo
        combo.setCurrentIndex(combo.findData("lit"))
        lit = ed._canvas.fire_view_point()
        combo.setCurrentIndex(combo.findData("ember"))
        ember = ed._canvas.fire_view_point()
        self.assertNotEqual((round(lit.x(), 3), round(lit.y(), 3)),
                            (round(ember.x(), 3), round(ember.y(), 3)))

    def _click_at_uv(self, ed: PropPresetEditor, u: float, v: float) -> None:
        from PySide6.QtCore import QPoint, Qt as _Qt
        from PySide6.QtTest import QTest
        canvas = ed._canvas
        saved = canvas._fire_point, canvas._fire_configured
        canvas._fire_point, canvas._fire_configured = (u, v), True
        target = canvas.fire_view_point()
        canvas._fire_point, canvas._fire_configured = saved
        self.assertIsNotNone(target)
        QTest.mouseClick(canvas, _Qt.MouseButton.LeftButton, _Qt.KeyboardModifier.NoModifier,
                         QPoint(round(target.x()), round(target.y())))

    def test_picking_on_the_preview_writes_the_base_fire_point(self) -> None:
        """从最外层入口进：按下「点选起火点」、在画布上真点一下，数据落到基础块。"""
        ed = self._editor({"t": {"image": _REAL_IMAGE, "anchorX": 0.5, "anchorY": 0.9}})
        self._need_geometry(ed)
        ed._pick_fire_btn.click()
        self.assertTrue(ed._canvas.fire_pick_enabled())
        self.assertFalse(ed._dirty, "开点选模式不是数据改动")
        self._click_at_uv(ed, 0.3, 0.2)
        self.assertTrue(ed._dirty)
        ed.flush_to_model(True)
        fp = self.model.prop_presets["t"]["firePoint"]
        tol = 0.05   # 一个像素在贴图归一化坐标里的量级
        self.assertAlmostEqual(fp[0], 0.3, delta=tol)
        self.assertAlmostEqual(fp[1], 0.2, delta=tol)

    def test_picking_writes_the_previewed_state_when_it_overrides(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        self._need_geometry(ed)
        combo = ed._state_combo
        combo.setCurrentIndex(combo.findData("ember"))   # ember 自己覆盖了起火点
        ed._pick_fire_btn.click()
        self._click_at_uv(ed, 0.7, 0.6)
        ed.flush_to_model(True)
        t = self.model.prop_presets["t"]
        self.assertEqual(t["firePoint"], [0.5, 0.05], "状态覆盖了起火点时不许写到基础块")
        self.assertAlmostEqual(t["states"]["ember"]["firePoint"][0], 0.7, delta=0.05)
        self.assertAlmostEqual(t["states"]["ember"]["firePoint"][1], 0.6, delta=0.05)

    # ---- 粒子挂载（契约 v3）--------------------------------------------

    MOUNTED = {
        "image": _REAL_IMAGE, "anchorX": 0.5, "anchorY": 0.9, "firePoint": [0.5, 0.05],
        "particles": [{"effect": "paper_money", "point": [0.3, 0.6]}, {"effect": "paper_money"}],
        "states": {"lit": {}, "out": {"particles": []},
                   "ember": {"particles": [{"effect": "paper_money", "point": [0.7, 0.2]}]}},
    }

    def test_preview_draws_a_dot_per_particle_mount(self) -> None:
        ed = self._editor({"t": self.MOUNTED})
        self._need_geometry(ed)
        combo = ed._state_combo
        combo.setCurrentIndex(combo.findData("lit"))
        pts = ed._canvas.particle_mount_view_points()
        self.assertEqual([e for e, _ in pts], ["paper_money", "paper_money"])
        fire = ed._canvas.fire_view_point()
        self.assertAlmostEqual(pts[1][1].x(), fire.x(), places=6, msg="没写 point 落到起火点")
        self.assertAlmostEqual(pts[1][1].y(), fire.y(), places=6)
        self.assertNotAlmostEqual(pts[0][1].y(), fire.y(), places=1)
        combo.setCurrentIndex(combo.findData("out"))
        self.assertEqual(ed._canvas.particle_mount_view_points(), [], "状态写了空数组 = 没有粒子")
        combo.setCurrentIndex(combo.findData("ember"))
        self.assertEqual(len(ed._canvas.particle_mount_view_points()), 1, "状态的列表整体替换基础块")
        self.assertFalse(ed._dirty, "切预览状态不是数据改动")

    def test_picking_a_base_particle_mount_from_its_row(self) -> None:
        """从最外层入口进：行尾「点选」→ 在预览上真点一下 → 那一条的 point 变了，起火点不动。"""
        from PySide6.QtWidgets import QPushButton
        ed = self._editor({"t": self.MOUNTED})
        self._need_geometry(ed)
        row0 = ed._particles_block._list._rows[0]["host"]
        [b for b in row0.findChildren(QPushButton) if b.text() == "点选"][0].click()
        self.assertTrue(ed._canvas.fire_pick_enabled())
        self.assertFalse(ed._dirty, "开点选模式不是数据改动")
        self._click_at_uv(ed, 0.45, 0.35)
        ed.flush_to_model(True)
        t = self.model.prop_presets["t"]
        self.assertAlmostEqual(t["particles"][0]["point"][0], 0.45, delta=0.05)
        self.assertAlmostEqual(t["particles"][0]["point"][1], 0.35, delta=0.05)
        self.assertEqual(t["particles"][1], {"effect": "paper_money"}, "别的挂载不动")
        self.assertEqual(t["firePoint"], [0.5, 0.05], "点的是挂载，不许写到起火点")
        ed._pick_fire_btn.click()                          # 关掉点选 = 下一次回到写起火点
        self.assertIsNone(ed._pick_target)

    def test_picking_a_state_particle_mount_switches_the_preview_to_that_state(self) -> None:
        from PySide6.QtWidgets import QPushButton
        ed = self._editor({"t": self.MOUNTED})
        self._need_geometry(ed)
        se = ed._states_editor
        se.ensure_built()
        se._on_select("ember")
        items = se._list.findItems("ember", se._list_match())
        se._list.setCurrentItem(items[0])
        row0 = se._st_particles._list._rows[0]["host"]
        [b for b in row0.findChildren(QPushButton) if b.text() == "点选"][0].click()
        self.assertEqual(ed._state_combo.currentData(), "ember")
        self._click_at_uv(ed, 0.2, 0.4)
        ed.flush_to_model(True)
        t = self.model.prop_presets["t"]
        self.assertAlmostEqual(t["states"]["ember"]["particles"][0]["point"][0], 0.2, delta=0.05)
        self.assertEqual(t["particles"][0]["point"], [0.3, 0.6], "基础块那一串不动")

    def test_particle_block_is_lazy_and_add_row_marks_dirty(self) -> None:
        ed = self._editor({"t": {"image": _REAL_IMAGE}})
        self.assertFalse(ed._particles_block._built, "没配粒子的挂件不该造控件（懒建）")
        ed._particles_block._section.set_expanded(True)
        self.assertTrue(ed._particles_block._built)
        self.assertNotIn("particles", ed._staged()["t"], "展开不是改动：不凭空写 particles: []")
        self.assertFalse(ed._dirty)
        ed._particles_block._list._on_add()
        self.assertTrue(ed._dirty)
        ed.flush_to_model(True)
        self.assertEqual(self.model.prop_presets["t"]["particles"], [{"effect": ""}])

    def test_particle_rows_reorder(self) -> None:
        from PySide6.QtWidgets import QPushButton
        ed = self._editor({"t": {"image": _REAL_IMAGE, "particles": [{"effect": "a"}, {"effect": "b"}]}})
        row1 = ed._particles_block._list._rows[1]["host"]
        [b for b in row1.findChildren(QPushButton) if b.text() == "↑"][0].click()
        ed.flush_to_model(True)
        self.assertEqual([m["effect"] for m in self.model.prop_presets["t"]["particles"]], ["b", "a"])

    def test_burn_and_wind_tooltips_cover_flame_and_particles(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        for tip in (ed._fire_block._burn.toolTip(), ed._states_editor._st_burn.toolTip()):
            self.assertIn("帧动画火苗", tip)
            self.assertIn("全部粒子挂载", tip)
            self.assertIn("burn^0.4", tip)
            self.assertIn("留缺省 1", tip)
        self.assertIn("全部粒子挂载", ed._fire_block._wind_shelter.toolTip())

    def test_expanded_fire_block_is_not_squeezed_flat(self) -> None:
        ed = self._editor({"t": FIRE_PRESET})
        body = ed._fire_block._body
        self.assertGreaterEqual(body.sizeHint().height(), 120,
                                f"火焰块展开后高度只有 {body.sizeHint().height()}px —— 被压成一条缝了")


class PropStateOnEnterActionScanTests(unittest.TestCase):
    """`states[*].onEnterActions` 是一个新的「带动作列表的位置」：物件 `use.actions` 被扫到的
    每一处（引用校验 / 动作总表 / 信号目录与改名 / flag 引用 / 对话图与实体重构 / 任务引用 /
    挂件引用 / 信号关系）都必须同样扫到它。每条都从各面的公开入口进，不摸内部表。
    """

    PROP = "torch"

    def _model(self, on_enter: list) -> ProjectModel:
        from tempfile import TemporaryDirectory

        from tools.editor.tests.save_test_utils import write_minimal_loadable_project
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name) / "p"
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        m.scenes["sc_a"]["npcs"] = [{"id": "更夫", "x": 0, "y": 0}]
        m.prop_presets = {
            self.PROP: {"image": _REAL_IMAGE,
                        "states": {"lit": {}, "out": {"onEnterActions": on_enter}},
                        "defaultState": "lit"},
            "sword": {"image": _REAL_IMAGE},
        }
        m._dirty.clear()
        return m

    def test_embedded_tag_refs_are_save_gated(self) -> None:
        bad = "坏 [tag:item:__definitely_missing__]"
        for acts in (
            [{"type": "chooseAction", "params": {"prompt": bad, "options": []}}],
            [{"type": "runActions", "params": {"actions": [
                {"type": "chooseAction", "params": {"prompt": bad, "options": []}}]}}],
        ):
            from tools.editor.shared.ref_validator import validate_refs_for_save
            m = self._model(acts)
            with self.subTest(nested=acts[0]["type"]):
                err = validate_refs_for_save(m, dirty={"prop_presets"})
                self.assertTrue(err, "状态进入动作里的悬垂 [tag:] 必须拦下保存")
                self.assertIn("prop_presets[torch].states[out].onEnterActions", err)
        m = self._model([{"type": "chooseAction", "params": {"prompt": "好 [tag:item:i_ok]",
                                                             "options": []}}])
        from tools.editor.shared.ref_validator import validate_refs_for_save
        self.assertIsNone(validate_refs_for_save(m, dirty={"prop_presets"}))

    def test_action_registry_lists_them_and_can_navigate(self) -> None:
        from tools.editor.editors.action_registry_editor import (
            _ACTION_REGISTRY_DIRTY_TYPES, _SOURCE_MAP, _scan_actions,
        )
        from tools.editor.main_window import SOURCE_NAVIGATION_TABS
        m = self._model([{"type": "runActions", "params": {"actions": [
            {"type": "playSfx", "params": {"id": "s"}}]}}])
        hits = [r for r in _scan_actions(m) if r.source_type == "prop_preset"]
        self.assertEqual([h.action_type for h in hits], ["runActions", "playSfx"],
                         "嵌套容器也要展开（共 N 条）")
        self.assertEqual({h.source_id for h in hits}, {self.PROP})
        self.assertIn("states.out.onEnterActions", hits[0].container_field)
        self.assertIn("prop_preset", _SOURCE_MAP.values(), "来源筛选下拉要能选到")
        self.assertIn("prop_presets", _ACTION_REGISTRY_DIRTY_TYPES, "改了挂件预设要标记重扫")
        self.assertEqual(SOURCE_NAVIGATION_TABS.get("prop_preset"), "挂件预设")
        main_src = (_ROOT / "tools" / "editor" / "main_window.py").read_text(encoding="utf-8")
        self.assertIn('"挂件预设", PropPresetEditor', main_src, "跳转标签必须是真实页签名")
        self.assertTrue(all(h.navigable for h in hits))

    def test_emitted_signals_and_signal_rename_reach_them(self) -> None:
        from tools.editor.shared.narrative_catalog import emitted_signal_ids
        from tools.editor.shared.signal_refactor import scan_signal_usages
        m = self._model([{"type": "emitNarrativeSignal", "params": {"signal": "火把灭了"}}])
        self.assertIn("火把灭了", emitted_signal_ids(m))
        assets = scan_signal_usages(m, "火把灭了")["assets"]
        self.assertEqual(
            [(a["bucket"], a["itemId"], a["count"]) for a in assets],
            [("prop_presets", self.PROP, 1)])

    def test_signal_rename_rewrites_and_marks_prop_presets_dirty(self) -> None:
        from tools.editor.shared.signal_refactor import rename_signal
        m = self._model([{"type": "emitNarrativeSignal", "params": {"signal": "火把灭了"}}])
        m.narrative_graphs = {"signals": [{"id": "火把灭了"}], "compositions": []}
        m._dirty.clear()
        rename_signal(m, "火把灭了", "火把熄了")
        act = m.prop_presets[self.PROP]["states"]["out"]["onEnterActions"][0]
        self.assertEqual(act["params"]["signal"], "火把熄了")
        self.assertIn("prop_presets", m._dirty)

    def test_flag_key_references_and_rename(self) -> None:
        from tools.editor.editors.flag_registry_editor import (
            find_flag_key_references, rename_flag_key_references,
        )
        m = self._model([{"type": "runActionsIf", "params": {
            "condition": {"flag": "torch_out"},
            "actions": [{"type": "setFlag", "params": {"key": "torch_out", "value": True}}]}}])
        refs = find_flag_key_references(m, "torch_out")
        self.assertEqual(len([r for r in refs if r.startswith("prop_presets")]), 2, refs)
        self.assertEqual(rename_flag_key_references(m, "torch_out", "torch_dead"), 2)
        self.assertIn("prop_presets", m._dirty)
        self.assertIn("torch_dead", m.all_flags())

    def test_dialogue_graph_usages_include_state_actions(self) -> None:
        from tools.editor.shared.dialogue_graph_refactor import scan_dialogue_graph_usages
        m = self._model([{"type": "startDialogueGraph", "params": {"graphId": "某段对话"}}])
        usages = scan_dialogue_graph_usages(m, "某段对话")
        self.assertTrue(any("prop_presets" in (u.get("path", "") + u.get("owner", ""))
                            for u in usages), usages)

    def test_entity_usages_include_state_actions(self) -> None:
        from tools.editor.shared.entity_refactor import scan_entity_usages
        m = self._model([{"type": "setPropState", "params": {
            "target": "更夫", "socket": "right_hand", "state": "out"}}])
        report = scan_entity_usages(m, "sc_a", "npc", "更夫")
        self.assertIn({"bucket": "prop_presets", "itemId": self.PROP, "count": 1},
                      report["globalRefs"])

    def test_prop_references_inside_state_actions_are_found_and_renamed(self) -> None:
        from tools.editor.shared.prop_preset_refs import (
            rename_prop_references, scan_prop_usages,
        )
        m = self._model([{"type": "attachToSocket", "params": {
            "target": "player", "socket": "left_hand", "prop": "sword"}}])
        self.assertEqual(scan_prop_usages(m, "sword"), [f"prop_presets {self.PROP}"])
        self.assertEqual(rename_prop_references(m, "sword", "taomu"), 1)
        self.assertIn("prop_presets", m._dirty)

    def test_quest_reference_scan_units_include_prop_presets(self) -> None:
        from types import SimpleNamespace

        from tools.editor.editors.quest_editor import QuestEditor
        m = self._model([])
        units = QuestEditor._quest_ref_scan_units(SimpleNamespace(_model=m))
        self.assertIn(("prop_presets.json", "prop_presets"),
                      [(label, bucket) for label, _obj, bucket, _sid in units])

    def test_narrative_xref_sees_state_actions_in_memory_and_on_disk(self) -> None:
        from tools.narrative_xref.sources import from_disk, from_project_model
        m = self._model([{"type": "emitNarrativeSignal", "params": {"signal": "火把灭了"}}])
        mem = [a for a in from_project_model(m).assets if a.attr == "prop_presets"]
        self.assertEqual(len(mem), 1)
        self.assertEqual(mem[0].file, "public/assets/data/prop_presets.json")
        disk = [a for a in from_disk(_ROOT).assets if a.attr == "prop_presets"]
        self.assertEqual(len(disk), 1, "磁盘来源同一张表，同一个文件")


class HeldPropActionValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.model = _model()
        cls.model.prop_presets = {
            "torch": {"image": _REAL_IMAGE,
                      "states": {"lit": {}, "out": {}}, "defaultState": "lit"},
        }
        cls.model.scenes["__灯场景"] = {
            "npcs": [{"id": "更夫", "x": 0, "y": 0}],
            "lighting": {"lights": [{"id": "门灯", "kind": "point", "intensity": 1,
                                     "range": 100, "pos": [0, 0, 0]}]},
        }

    def _issues(self, act: dict, scene: str | None) -> list:
        from tools.editor.validator import _append_action_param_ref_issues
        out: list = []
        _append_action_param_ref_issues(self.model, out, act, "probe", "p", scene)
        return out

    def test_unknown_prop_state_is_an_error(self) -> None:
        out = self._issues({"type": "setPropState",
                            "params": {"target": "player", "socket": "h",
                                       "state": "根本没这个状态"}}, "__灯场景")
        self.assertTrue(any(i.severity == "error" and "根本没这个状态" in i.message for i in out),
                        [i.message for i in out])

    def test_known_prop_state_is_clean(self) -> None:
        out = self._issues({"type": "setPropState",
                            "params": {"target": "player", "socket": "h", "state": "lit"}},
                           "__灯场景")
        self.assertEqual([i.message for i in out if i.severity == "error"], [])

    def test_attach_state_checked_against_its_own_prop(self) -> None:
        bad = self._issues({"type": "attachToSocket",
                            "params": {"target": "player", "socket": "h",
                                       "prop": "torch", "state": "out"}}, "__灯场景")
        self.assertEqual([i.message for i in bad if i.severity == "error"], [])
        worse = self._issues({"type": "attachToSocket",
                              "params": {"target": "player", "socket": "h",
                                         "prop": "torch", "state": "lit2"}}, "__灯场景")
        self.assertTrue(any("lit2" in i.message for i in worse if i.severity == "error"))

    def test_unknown_light_id_is_a_warning_not_an_error(self) -> None:
        """灯表可能写在别的时段组 / 这段内容在别的场景复用 ⇒ 报 error 会淹掉 error 通道。"""
        out = self._issues({"type": "fadeLight",
                            "params": {"lightId": "没有这盏灯", "scale": 0}}, "__灯场景")
        self.assertEqual([i.message for i in out if i.severity == "error"], [])
        self.assertTrue(any("没有这盏灯" in i.message for i in out if i.severity == "warning"),
                        [i.message for i in out])

    def test_known_light_id_is_clean(self) -> None:
        out = self._issues({"type": "fadeLight",
                            "params": {"lightId": "门灯", "scale": 0}}, "__灯场景")
        self.assertEqual([i.message for i in out], [])

    def test_no_scene_context_skips_the_light_check(self) -> None:
        out = self._issues({"type": "fadeLight",
                            "params": {"lightId": "谁知道", "scale": 0}}, None)
        self.assertEqual([i.message for i in out], [])

    def test_negative_fade_light_scale_is_an_error(self) -> None:
        out = self._issues({"type": "fadeLight",
                            "params": {"lightId": "门灯", "scale": -1}}, "__灯场景")
        self.assertTrue(any(i.severity == "error" for i in out))


class SceneLightFollowValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.model = _model()
        cls.model.scenes["__跟随场景"] = {"npcs": [{"id": "更夫", "x": 0, "y": 0}]}

    def _issues(self, lights: list) -> list[str]:
        from tools.editor.validator import _scene_light_follow_issues
        return _scene_light_follow_issues(self.model, "__跟随场景", lights)

    def _light(self, **kw) -> dict:
        base = {"id": "灯笼", "kind": "point", "intensity": 1, "range": 100,
                "pos": [0, 0, 0]}
        base.update(kw)
        return base

    def test_no_follow_is_clean(self) -> None:
        self.assertEqual(self._issues([self._light()]), [])

    def test_player_and_scene_npc_resolve(self) -> None:
        for target in ("player", "更夫"):
            with self.subTest(target=target):
                self.assertEqual(self._issues([self._light(follow={"target": target})]), [])

    def test_unresolvable_target_is_an_error(self) -> None:
        out = self._issues([self._light(follow={"target": "别的场景的人"})])
        self.assertTrue(any("别的场景的人" in t for t in out), out)

    def test_missing_target_is_an_error(self) -> None:
        out = self._issues([self._light(follow={"socket": "right_hand"})])
        self.assertTrue(any("缺 target" in t for t in out), out)

    def test_follow_must_be_an_object(self) -> None:
        self.assertTrue(self._issues([self._light(follow="更夫")]))

    def test_unknown_follow_key_is_reported(self) -> None:
        """认不出来的键留在 JSON 里是静默失效（运行时忽略，作者以为配了）。"""
        out = self._issues([self._light(follow={"target": "player", "heightM": 1})])
        self.assertTrue(any("heightM" in t for t in out), out)

    def test_bad_offset_shape_is_reported(self) -> None:
        out = self._issues([self._light(follow={"target": "player", "offset": [0, 1]})])
        self.assertTrue(any("offset" in t for t in out), out)

    def test_follow_lights_count_toward_the_shadow_budget(self) -> None:
        """跟随灯进的是同一批灯槽、同一份阴影预算——从计数里摘掉就是面板报少了。"""
        from tools.editor.editors.scene_lights import (
            SHADOW_LIGHT_BUDGET, shadow_budget_status,
        )
        lights = [
            self._light(id=f"跟随{i}", castShadow=True, follow={"target": "player"})
            for i in range(SHADOW_LIGHT_BUDGET + 1)
        ]
        n, budget, over = shadow_budget_status(lights)
        self.assertEqual((n, budget), (SHADOW_LIGHT_BUDGET + 1, SHADOW_LIGHT_BUDGET))
        self.assertTrue(over)
        out = self._issues(lights)
        self.assertTrue(any("跟随灯" in t and "预算" in t for t in out), out)

    def test_within_budget_says_nothing_about_cost(self) -> None:
        out = self._issues([self._light(castShadow=True, follow={"target": "player"})])
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
