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
    VfxIdListField,
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
    "vfx": [],
    "persistent": True,
    "states": {
        "lit": {"label": "点着"},
        "ember": {"label": "残炭", "light": {"intensity": 1}, "scale": 1},
        "out": {"label": "灭", "light": None, "vfx": [], "lit": True},
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
        light/vfx/persistent/states —— 那是**改行为**，不是格式漂移。"""
        out = self._roundtrip({"x": {"image": _REAL_IMAGE}})
        self.assertEqual(out, {"x": {"image": _REAL_IMAGE}})
        for key in ("light", "vfx", "persistent", "states", "defaultState", "lit"):
            self.assertNotIn(key, out["x"], f"最小形态凭空多出 {key}")

    def test_empty_entry_stays_empty(self) -> None:
        self.assertEqual(self._roundtrip({"y": {}}), {"y": {}})

    def test_explicit_empty_vfx_list_is_preserved(self) -> None:
        """磁盘上显式写着 `vfx: []` 的不能被抹掉（"等于缺省就删"会改字节）。"""
        out = self._roundtrip({"z": {"image": _REAL_IMAGE, "vfx": []}})
        self.assertEqual(out["z"].get("vfx"), [])

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

    def test_state_vfx_is_also_three_state(self) -> None:
        ed = self._editor({"a": {}, "b": {"vfx": []}, "c": {"vfx": ["paper_money"]}})
        try:
            states, _ = ed.dump()
            self.assertNotIn("vfx", states["a"])
            self.assertEqual(states["b"]["vfx"], [], "空数组 = 这个状态没有效果，不是「没写」")
            self.assertEqual(states["c"]["vfx"], ["paper_money"])
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

    def test_vfx_ids_are_not_bare_line_edits(self) -> None:
        """选择器铁律：效果 id 是跨文件引用，禁裸 QLineEdit，候选取自 id-provider。"""
        f = VfxIdListField(self.model, ["paper_money"], None)
        try:
            self.assertEqual(len(f._rows), 1)
            sel = f._rows[0]
            self.assertIsInstance(sel, IdRefSelector)
            self.assertNotIsInstance(sel, QLineEdit)
            self.assertEqual(sel.current_id(), "paper_money")
            known = {rid for rid, _ in getattr(sel, "_items_normalized_cache", ())}
            self.assertTrue(known, "候选必须来自 ProjectModel.all_vfx_effect_ids()")
        finally:
            f.deleteLater()

    def test_dangling_vfx_id_is_preserved(self) -> None:
        f = VfxIdListField(self.model, ["绝不存在的效果"], None)
        try:
            self.assertEqual(f.to_list(), ["绝不存在的效果"])
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
        table["vfx"] = []
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

    def test_missing_vfx_asset_is_an_error(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["vfx"] = ["绝不存在的效果"]
        msgs = self._errors(self._issues({"t": table}))
        self.assertTrue(any("绝不存在的效果" in m for m in msgs), msgs)

    def test_missing_vfx_asset_in_a_state_is_an_error(self) -> None:
        table = copy.deepcopy(FULL_PRESET)
        table["states"]["lit"]["vfx"] = ["绝不存在的效果"]
        msgs = self._errors(self._issues({"t": table}))
        self.assertTrue(any("states[lit].vfx" in m for m in msgs), msgs)

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
