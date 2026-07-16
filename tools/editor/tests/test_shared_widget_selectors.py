"""共享控件选择器 / 保值 / 信号契约护栏（2026-07-14 主编辑器审查 W 组修复的回归锁）。

锁定形状（全部为审查中探针实测复现或防漂移）：
- CONTENT_ID_PARAMS 每个登记项在 ActionRow 构造出的控件都不是裸 QLineEdit（防第四处漂移）；
- addFlagValue.key 走 FlagKeyPickField；startPressureHold.id / playSignalCue.id 走 id 选择器；
  三者悬垂旧值均保值往返；
- 空列表不自动注入空行：enableRuleOffers slots:[] / chooseAction options:[] 往返仍为 []；
- 出生点下拉不再出现 "(none)"/"(default)" 双空值；
- 场景切换时 hotspot/zone 子选择器保值（旧 id 不在新场景候选时不静默顶替第一项）；
- 切换 Action 类型：参数非空时确认，用户放弃则类型与参数原样保留；
- condition 树 scenario 叶子经清单刷新后不丢；set_expr 程序性载入不外发 changed；
- 裸 not（内层空）亮红字恒假提示；
- FlagKeyPickField.set_key_silent 不发信号、set_key 仍发信号；
- RichTextTextEdit 无 [tag:] 文本时不显示"（引用校验通过）"提示行。
"""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLineEdit

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor, ActionRow
from tools.editor.shared.condition_editor import ConditionEditor
from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget
from tools.editor.shared.flag_key_field import FlagKeyPickField
from tools.editor.shared.id_ref_selector import IdRefSelector
from tools.editor.shared.rich_text_field import RichTextTextEdit
from tools.editor.tests.save_test_utils import repo_root_from_tests
from tools.json_lang.schema_build import CONTENT_ID_PARAMS


def _roundtrip_action(model: ProjectModel, action: dict, scene_id: str | None) -> dict:
    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([action])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


class ContentIdParamsParityTests(unittest.TestCase):
    """P1-12 parity（FIX-1「宇宙级」升级）：CONTENT_ID_PARAMS 每个登记项建出的选择器，
    其服务的内容宇宙必须与 schema_build 声明的宇宙一致——不只是"非裸 QLineEdit"。

    对抗组 V4 实证：旧护栏只验"不是裸手输框"，把 giveItem.id 接成 rule 选择器仍 PASS。
    本轮 action_editor 给每个 id 引用选择器打 `_content_id_universe` 标记（源自它实际
    用哪个宇宙的 id-provider 建候选），此处断言标记 == CONTENT_ID_PARAMS 声明宇宙。
    接错宇宙（giveItem.id→rule 选择器）会当场 FAIL。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def test_no_registered_id_param_is_bare_qlineedit(self) -> None:
        offenders: list[str] = []
        for (act, param) in sorted(CONTENT_ID_PARAMS):
            row = ActionRow({"type": act, "params": {}}, model=self.model, scene_id=self.scene_id)
            w = row._param_widgets.get(param)
            # 每个登记项都必须建出对应参数控件（缺控件=写不出该 id）
            self.assertIsNotNone(w, f"{act}.{param} 未建出参数控件")
            if type(w) is QLineEdit:
                offenders.append(f"{act}.{param}")
        self.assertEqual(
            offenders, [],
            f"CONTENT_ID_PARAMS 登记项仍是裸 QLineEdit（违选择器铁律）：{offenders}",
        )

    def test_selector_universe_matches_declared_universe(self) -> None:
        """宇宙级 parity：控件服务的宇宙必须与登记宇宙一致（接错宇宙即 FAIL）。"""
        mismatches: list[str] = []
        for (act, param) in sorted(CONTENT_ID_PARAMS):
            want = CONTENT_ID_PARAMS[(act, param)]
            row = ActionRow({"type": act, "params": {}}, model=self.model, scene_id=self.scene_id)
            w = row._param_widgets.get(param)
            self.assertIsNotNone(w, f"{act}.{param} 未建出参数控件")
            got = getattr(w, "_content_id_universe", None)
            if got != want:
                mismatches.append(
                    f"{act}.{param}: 声明宇宙={want!r} 但选择器服务宇宙={got!r}"
                    f"（widget={type(w).__name__}）"
                )
        self.assertEqual(
            mismatches, [],
            "CONTENT_ID_PARAMS 登记项的选择器接错/未标记宇宙——"
            "手打错宇宙的 id 会被静默接受、validator 抓不到、运行时找不到目标：\n"
            + "\n".join(mismatches),
        )


class FlagAndCueSelectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def test_add_flag_value_key_widget_is_flag_picker(self) -> None:
        row = ActionRow(
            {"type": "addFlagValue", "params": {"key": "some_counter", "delta": 1}},
            model=self.model, scene_id=self.scene_id,
        )
        self.assertIsInstance(row._param_widgets.get("key"), FlagKeyPickField)

    def test_add_flag_value_dangling_key_roundtrip(self) -> None:
        act = {"type": "addFlagValue", "params": {"key": "ghost_flag_不存在", "delta": 5}}
        self.assertEqual(_roundtrip_action(self.model, act, self.scene_id), act)

    def test_pressure_hold_widget_is_selector(self) -> None:
        row = ActionRow(
            {"type": "startPressureHold", "params": {"id": ""}},
            model=self.model, scene_id=self.scene_id,
        )
        self.assertIsInstance(row._param_widgets.get("id"), IdRefSelector)

    def test_signal_cue_widget_is_selector(self) -> None:
        row = ActionRow(
            {"type": "playSignalCue", "params": {"id": ""}},
            model=self.model, scene_id=self.scene_id,
        )
        self.assertIsInstance(row._param_widgets.get("id"), IdRefSelector)

    def test_pressure_hold_dangling_id_roundtrip(self) -> None:
        act = {"type": "startPressureHold", "params": {"id": "ghost_hold_不存在"}}
        self.assertEqual(_roundtrip_action(self.model, act, self.scene_id), act)

    def test_signal_cue_dangling_id_roundtrip(self) -> None:
        act = {"type": "playSignalCue", "params": {"id": "ghost_cue_不存在"}}
        self.assertEqual(_roundtrip_action(self.model, act, self.scene_id), act)


class EmptyListNoInjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def test_enable_rule_offers_empty_slots_roundtrip(self) -> None:
        act = {"type": "enableRuleOffers", "params": {"slots": []}}
        self.assertEqual(_roundtrip_action(self.model, act, self.scene_id), act)

    def test_choose_action_empty_options_roundtrip(self) -> None:
        act = {"type": "chooseAction", "params": {"prompt": "选", "options": []}}
        self.assertEqual(_roundtrip_action(self.model, act, self.scene_id), act)


class SpawnSelectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())

    def test_spawn_selector_no_double_empty_value(self) -> None:
        # 选一个含出生点的场景
        target = None
        for sid in self.model.all_scene_ids():
            if len(self.model.spawn_point_keys_for_scene(sid)) > 1:
                target = sid
                break
        if not target:
            self.skipTest("工程无含出生点的场景")
        row = ActionRow(
            {"type": "switchScene", "params": {"targetScene": target}},
            model=self.model, scene_id=None,
        )
        sp = row._param_widgets.get("targetSpawnPoint")
        self.assertIsInstance(sp, IdRefSelector)
        texts = [sp.itemText(i) for i in range(sp.count())]
        self.assertNotIn("(default)", texts, "出生点下拉不应再出现 (default) 同义空值")
        # 空值仍只经 allow_empty 的 (none) 承载
        self.assertEqual(texts.count("(none)"), 1)


class ScopedComboPreserveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())

    def test_hotspot_scene_switch_preserves_dangling_id(self) -> None:
        scenes = self.model.all_scene_ids()
        if len(scenes) < 2:
            self.skipTest("场景不足两个")
        row = ActionRow(
            {"type": "persistHotspotEnabled",
             "params": {"sceneId": scenes[0], "hotspotId": "ghost_hs_不存在", "enabled": True}},
            model=self.model, scene_id=None,
        )
        scene_w = row._param_widgets.get("sceneId")
        # 切到另一场景：旧悬垂 hotspotId 不得被静默顶替
        scene_w.set_committed_type(scenes[1], emit=True)
        out = row.to_dict()
        self.assertEqual(out["params"].get("hotspotId"), "ghost_hs_不存在")


class TypeSwitchConfirmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def test_decline_switch_keeps_type_and_params(self) -> None:
        row = ActionRow(
            {"type": "giveItem", "params": {"id": "some_item", "count": 2}},
            model=self.model, scene_id=self.scene_id,
        )
        row._confirm_type_switch_clear = lambda *a, **k: False  # 模拟用户点"否"
        row.type_combo.set_committed_type("setFlag", emit=True)
        out = row.to_dict()
        self.assertEqual(out["type"], "giveItem")
        self.assertEqual(out["params"].get("id"), "some_item")

    def test_accept_switch_clears_params(self) -> None:
        row = ActionRow(
            {"type": "giveItem", "params": {"id": "some_item", "count": 2}},
            model=self.model, scene_id=self.scene_id,
        )
        row._confirm_type_switch_clear = lambda *a, **k: True  # 模拟用户点"是"
        row.type_combo.set_committed_type("endDay", emit=True)
        out = row.to_dict()
        self.assertEqual(out["type"], "endDay")
        self.assertNotIn("id", out.get("params", {}))


class ConditionTreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())

    def test_scenario_leaf_survives_dropdown_refresh(self) -> None:
        # 用不在 catalog 的 scenario/phase：正是 _fill_scenario_combos 刷新会清成（选择）的破口。
        # 修复后应以「（数据）」注入保留，get_expr 不丢。
        expr = {"scenario": "码头水鬼", "phase": "p1", "status": "done"}
        tree = ConditionExprTreeRootWidget(model_getter=lambda: self.model)
        tree.set_expr(expr)
        self.assertEqual(tree.get_expr(), expr)
        # 模拟"清单变更后刷新"：不得把已选 scenario/phase 清成（选择）
        tree.set_model_refresh()
        self.assertEqual(tree.get_expr(), expr)

    def test_set_expr_does_not_emit_changed(self) -> None:
        # H 组修复：旧断言用扁平 flag 叶子——flag 分支载入全靠 set_key_silent/blockSignals，
        # 就算摘掉 _loading 抑制也不发信号，是空转（关抑制仍 PASS，护栏不咬）。
        # 换成带子节点的 all 表达式：set_dict 会调 _add_child()，其末尾无条件 _emit_changed()，
        # 唯一拦它的就是 _loading 抑制。抑制在→hits==[]；抑制被摘→_add_child 的 _emit_changed
        # 直接外发 changed，本断言当场 FAIL（真能区分"有抑制"vs"无抑制"）。
        tree = ConditionExprTreeRootWidget(model_getter=lambda: self.model)
        hits: list[int] = []
        tree.changed.connect(lambda: hits.append(1))
        tree.set_expr({
            "all": [
                {"flag": "some_flag", "value": True},
                {"flag": "other_flag", "value": False},
            ],
        })
        self.assertEqual(hits, [], "程序性 set_expr（含子节点 all）不得外发 changed")

    def test_condition_editor_set_data_does_not_emit_changed(self) -> None:
        ed = ConditionEditor("t")
        ed.set_flag_pattern_context(self.model, None)
        hits: list[int] = []
        ed.changed.connect(lambda: hits.append(1))
        ed.set_data([{"scenario": "s1", "phase": "p", "status": "done"}])
        self.assertEqual(hits, [], "程序性 set_data 不得外发 changed")

    def test_bare_not_shows_empty_hint(self) -> None:
        tree = ConditionExprTreeRootWidget(model_getter=lambda: self.model)
        tree.set_expr({"not": {"all": []}})
        root = tree._root
        self.assertEqual(root._active_kind, "not")
        self.assertIsNotNone(root._not_empty_hint)
        self.assertTrue(root._not_empty_hint.isVisible() or root._not_empty_hint.isVisibleTo(root))


class FlagKeyFieldSignalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_set_key_silent_does_not_emit(self) -> None:
        f = FlagKeyPickField(None, None, "")
        hits: list[int] = []
        f.valueChanged.connect(lambda: hits.append(1))
        f.set_key_silent("abc")
        self.assertEqual(f.key(), "abc")
        self.assertEqual(hits, [])

    def test_set_key_still_emits(self) -> None:
        f = FlagKeyPickField(None, None, "")
        hits: list[int] = []
        f.valueChanged.connect(lambda: hits.append(1))
        f.set_key("abc")
        self.assertEqual(f.key(), "abc")
        self.assertEqual(hits, [1])


class RichTextHintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())

    def test_no_tag_text_shows_no_hint(self) -> None:
        w = RichTextTextEdit(self.model)
        w.setPlainText("这是一段没有引用的普通说明")
        self.assertEqual(w._hint.text(), "")

    def test_valid_tag_text_shows_pass_hint(self) -> None:
        w = RichTextTextEdit(self.model)
        w.setPlainText("门口挂着 [tag:player:name]")
        # 有 tag 且校验通过才显示提示行（不再常驻空文本占位）
        self.assertNotEqual(w._hint.text(), "")


if __name__ == "__main__":
    unittest.main()
