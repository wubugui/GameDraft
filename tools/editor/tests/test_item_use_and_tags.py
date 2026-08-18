"""物件「自身用途」(`ItemDef.use`) 与标签 (`tags`) 的编辑器 / 校验器护栏。

覆盖三类历来最容易静默出错的路径：

1. **往返保真**——打开不动再 Apply，数据逐字节不变（标签顺序尤其：勾选框天然按词表
   顺序输出，直接那么写就把 ``["引火","辟邪"]`` 悄悄重排了）。
2. **三处同步**——新字段必须同时出现在 ``_on_select`` / ``_is_dirty`` / ``_apply``。
   漏 ``_is_dirty`` 时切物件不判脏，编辑被静默吞掉，而 flush / confirm_close 全靠它。
3. **登记面同步**——use.actions 让 items 从纯条件面升成信号发射面，动作总表要扫得到。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.action_registry_editor import _scan_actions
from tools.editor.editors.item_editor import ItemEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.item_tags import ITEM_TAGS
from tools.editor.shared.ref_validator import validate_refs_for_save
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import Issue, _validate_item_tags, _validate_item_use


def _full_item() -> dict:
    """带全部新字段的物件；tags 故意**不按词表顺序**，用来钉住顺序保真。"""
    return {
        "id": "i_full",
        "name": "烧酒",
        "type": "consumable",
        "description": "辣得很。",
        "maxStack": 5,
        "tags": ["引火", "辟邪"],
        "use": {
            "label": "灌一口",
            "conditions": [{"flag": "has_guts"}],
            "disableHint": "手抖得端不稳。",
            "consume": True,
            # 刻意选一条**参数只有一个、无跨文件引用、无白名单约束**的动作。两个理由：
            # 一是这里要钉的是"use.actions 真的走了动作校验"，不该把测试绑到 setFlag
            # 白名单/物品表这些会漂的工程内容上；二是 ActionEditor 会把 _PARAM_SCHEMAS
            # 里**没填的**参数materialize 成空串（showNotification 的 type 就会冒出
            # `"type": ""`），多参数动作的合成 fixture 天然过不了字节级往返——那是
            # ActionEditor 的既有行为，不是本次改动引入的（见 _meta/inbox 偏差记录）。
            "actions": [{"type": "playSfx", "params": {"id": "sfx_gulp"}}],
            "resultText": "一口下去，从喉咙烧到胃里。",
        },
    }


class ItemUseRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path, items: list[dict]) -> tuple[ItemEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.items = items
        ed = ItemEditor(model)
        ed._refresh()
        return ed, model

    def test_open_then_apply_changes_nothing(self) -> None:
        """打开→不动→Apply：逐字节不变（含 tags 的原始顺序与键序）。"""
        with TemporaryDirectory() as td:
            before = json.dumps(_full_item(), ensure_ascii=False, sort_keys=False)
            ed, model = self._editor(Path(td) / "p", [_full_item()])
            ed._list.setCurrentRow(0)
            ed._apply()
            after = json.dumps(model.items[0], ensure_ascii=False, sort_keys=False)
            self.assertEqual(before, after)

    def test_untouched_selection_is_not_dirty(self) -> None:
        """纯选择不判脏——否则「打开啥都没干直接关」也会弹保存（红线）。"""
        with TemporaryDirectory() as td:
            ed, _ = self._editor(Path(td) / "p", [_full_item()])
            ed._list.setCurrentRow(0)
            self.assertFalse(ed._is_dirty())

    def test_tag_order_survives_when_only_use_edited(self) -> None:
        """只改 use 时标签顺序不许被勾选框的排布顺序重写。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", [_full_item()])
            ed._list.setCurrentRow(0)
            ed._u_label.setText("猛灌一口")
            ed._apply()
            self.assertEqual(model.items[0]["tags"], ["引火", "辟邪"])
            self.assertEqual(model.items[0]["use"]["label"], "猛灌一口")

    def test_unknown_tag_is_preserved_not_dropped(self) -> None:
        """词表外的旧值必须保值展示并原样写回（共享控件保值契约）。"""
        with TemporaryDirectory() as td:
            item = _full_item()
            item["tags"] = ["祖传怪标签", "辟邪"]
            ed, model = self._editor(Path(td) / "p", [item])
            ed._list.setCurrentRow(0)
            self.assertTrue(ed._tag_boxes["祖传怪标签"].isChecked(), "未知标签要出现在勾选框里")
            self.assertFalse(ed._is_dirty(), "保值展示不应把未知标签判成改动")
            ed._apply()
            self.assertEqual(model.items[0]["tags"], ["祖传怪标签", "辟邪"])

    def test_new_category_can_be_added_without_touching_code(self) -> None:
        """加一个新类别不需要改代码——「+ 新类别」录一次即可勾选并落盘。

        这是"只改 JSON 就能做内容"的一部分：候选写死在 Python 里的话，加个「药材」
        就得改代码，策划自己走不通。
        """
        from PySide6.QtWidgets import QInputDialog

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", [_full_item()])
            ed._list.setCurrentRow(0)
            self.assertNotIn("药材", ed._tag_boxes)
            original = QInputDialog.getText
            QInputDialog.getText = staticmethod(  # type: ignore[assignment]
                lambda *a, **k: ("药材", True))
            try:
                ed._prompt_new_tag()
            finally:
                QInputDialog.getText = original  # type: ignore[assignment]
            self.assertTrue(ed._tag_boxes["药材"].isChecked())
            self.assertTrue(ed._is_dirty())
            ed._apply()
            self.assertIn("药材", model.items[0]["tags"])

    def test_tag_used_elsewhere_in_project_is_offered_here(self) -> None:
        """别的物件上录过的类别，在本条也直接可勾——不必每条重录一遍。"""
        with TemporaryDirectory() as td:
            other = {"id": "i_other", "name": "乙", "type": "consumable",
                     "description": "", "maxStack": 1, "tags": ["药材"]}
            ed, _ = self._editor(Path(td) / "p", [_full_item(), other])
            ed._list.setCurrentRow(0)
            self.assertIn("药材", ed._tag_boxes)
            self.assertFalse(ed._tag_boxes["药材"].isChecked(), "只是可勾，不是替人勾上")


class ItemUseThreeWaySyncTests(unittest.TestCase):
    """新字段的 _on_select / _is_dirty / _apply 三处必须齐活。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path) -> tuple[ItemEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.items = [
            _full_item(),
            {"id": "i1", "name": "乙", "type": "consumable", "description": "", "maxStack": 1},
        ]
        ed = ItemEditor(model)
        ed._refresh()
        return ed, model

    def test_on_select_loads_use_into_form(self) -> None:
        with TemporaryDirectory() as td:
            ed, _ = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            self.assertTrue(ed._u_enabled.isChecked())
            self.assertEqual(ed._u_label.text(), "灌一口")
            self.assertEqual(ed._u_hint.text(), "手抖得端不稳。")
            self.assertEqual(ed._u_actions.to_list()[0]["type"], "playSfx")
            self.assertTrue(ed._tag_boxes["辟邪"].isChecked())
            self.assertFalse(ed._tag_boxes["食物"].isChecked())

    def test_switching_item_clears_previous_use(self) -> None:
        """切到没有 use 的物件必须清空表单，否则上一件的用途会被写到这一件头上。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._list.setCurrentRow(1)
            self.assertFalse(ed._u_enabled.isChecked())
            self.assertEqual(ed._u_label.text(), "")
            self.assertEqual(ed._u_actions.to_list(), [])
            ed._apply()
            self.assertNotIn("use", model.items[1])
            self.assertNotIn("tags", model.items[1])

    def test_use_edit_is_dirty_and_commits_on_leave(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._u_result.setPlainText("辣得眼泪都出来了。")
            self.assertTrue(ed._is_dirty(), "改了 use 必须判脏，否则切走即丢")
            ed._list.setCurrentRow(1)          # 切走，不点 Apply
            self.assertEqual(model.items[0]["use"]["resultText"], "辣得眼泪都出来了。")

    def test_tag_toggle_is_dirty_and_commits(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._tag_boxes["食物"].setChecked(True)
            self.assertTrue(ed._is_dirty(), "改了 tags 必须判脏")
            ed._list.setCurrentRow(1)
            self.assertIn("食物", model.items[0]["tags"])
            self.assertEqual(model.items[0]["tags"][:2], ["引火", "辟邪"], "新标签追加在原顺序之后")

    def test_unchecking_use_deletes_the_key(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._u_enabled.setChecked(False)
            self.assertTrue(ed._is_dirty())
            ed._apply()
            self.assertNotIn("use", model.items[0], "不勾＝删键，不是写一个空对象")

    def test_consume_tri_state_default_writes_no_key(self) -> None:
        """「按类型（默认）」必须不写 consume 键——写默认值会把"没配"伪装成"配了"。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._u_consume.setCurrentIndex(0)
            ed._apply()
            self.assertNotIn("consume", model.items[0]["use"])
            ed._u_consume.setCurrentIndex(2)   # 显式"不消耗"
            ed._apply()
            self.assertIs(model.items[0]["use"]["consume"], False)

    def test_commit_pending_on_leave_hook_exists_and_commits(self) -> None:
        """切到别的编辑器页时的提交钩子（mainwindow-editor-hooks 契约 4）。

        该卡把「item 编辑器有 Apply 却没这个钩子」列为已知坑：改完不点 Apply 直接切页，
        模型里根本没有这次编辑。加了 use/actions 之后丢的东西更多，故补上并钉住。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._u_label.setText("闷一口")
            self.assertTrue(ed.commit_pending_on_leave())
            self.assertEqual(model.items[0]["use"]["label"], "闷一口")

    def test_discard_neutralizes_so_later_flush_does_not_revive(self) -> None:
        """confirm_close 的 Discard 必须把 UI 回滚到模型值。

        关闭路径是「逐页 confirm_close → 统一 flush」；flush 按 UI≠模型判脏，
        不中和就把刚被放弃的编辑重新提交回去。
        """
        from PySide6.QtWidgets import QMessageBox

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._u_label.setText("被放弃的编辑")
            original = QMessageBox.question
            QMessageBox.question = staticmethod(  # type: ignore[assignment]
                lambda *a, **k: QMessageBox.StandardButton.Discard)
            try:
                self.assertTrue(ed.confirm_close())
            finally:
                QMessageBox.question = original  # type: ignore[assignment]
            self.assertFalse(ed._is_dirty(), "Discard 后 UI 必须与模型一致")
            ed.flush_to_model()
            self.assertEqual(model.items[0]["use"]["label"], "灌一口", "被放弃的编辑不许复活")


class ItemUseValidatorTests(unittest.TestCase):
    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_clean_item_produces_no_issues(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            issues: list[Issue] = []
            item = _full_item()
            _validate_item_tags(item, "i_full", issues)
            _validate_item_use(model, item, "i_full", issues)
            self.assertEqual([i.message for i in issues], [])

    def test_empty_label_is_error(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            issues: list[Issue] = []
            item = _full_item()
            item["use"]["label"] = "   "
            _validate_item_use(model, item, "i_full", issues)
            self.assertTrue(any(i.severity == "error" and "label" in i.message for i in issues))

    def test_key_item_consumed_by_use_warns(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            issues: list[Issue] = []
            item = _full_item()
            item["type"] = "key"
            _validate_item_use(model, item, "i_full", issues)
            self.assertTrue(any(i.severity == "warning" and "关键道具" in i.message for i in issues))

    def test_use_without_any_feedback_warns(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            issues: list[Issue] = []
            item = _full_item()
            item["use"] = {"label": "用一下"}
            _validate_item_use(model, item, "i_full", issues)
            self.assertTrue(any("看不到任何反馈" in i.message for i in issues))

    def test_unregistered_action_inside_use_is_reported(self) -> None:
        """use.actions 必须真的走动作校验，否则物件里能藏一条运行时跳过的死动作。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            issues: list[Issue] = []
            item = _full_item()
            item["use"]["actions"] = [{"type": "__definitely_not_registered__", "params": {}}]
            _validate_item_use(model, item, "i_full", issues)
            self.assertTrue(
                any("__definitely_not_registered__" in i.message for i in issues))

    def test_unknown_tag_warns_but_does_not_error(self) -> None:
        issues: list[Issue] = []
        _validate_item_tags({"tags": ["驱邪"]}, "i", issues)
        self.assertTrue(issues)
        self.assertTrue(all(i.severity == "warning" for i in issues))
        self.assertTrue(any("词表外" in i.message for i in issues))

    def test_known_tags_are_silent(self) -> None:
        issues: list[Issue] = []
        _validate_item_tags({"tags": list(ITEM_TAGS)}, "i", issues)
        self.assertEqual(issues, [])

    def test_non_list_tags_is_error(self) -> None:
        issues: list[Issue] = []
        _validate_item_tags({"tags": "辟邪"}, "i", issues)
        self.assertTrue(any(i.severity == "error" for i in issues))


class ItemUseEmbeddedRefTests(unittest.TestCase):
    """use 的玩家可见文本与动作树里的 `[tag:…]` 必须进保存期引用校验。

    漏扫的后果不是报错而是**静默**：打错的 `[tag:item:xxx]` 存得下去，游戏里渲染成
    兜底串。"引用目标不存在就整工程存不了"正是这道校验存在的理由。
    """

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_good_refs_pass(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            model.items = [_full_item()]
            self.assertFalse(validate_refs_for_save(model, dirty={"item"}))

    def test_dangling_ref_in_each_use_text_field_is_caught(self) -> None:
        bad = "[tag:item:__definitely_missing__]"
        for field in ("label", "disableHint", "resultText"):
            with self.subTest(field=field), TemporaryDirectory() as td:
                model = self._model(Path(td) / "p")
                item = _full_item()
                item["use"][field] = f"坏引用 {bad}"
                model.items = [item]
                err = validate_refs_for_save(model, dirty={"item"})
                self.assertTrue(err, f"use.{field} 的悬垂引用必须被拦下")
                self.assertIn(f"use.{field}", err)

    def test_dangling_ref_inside_use_actions_is_caught(self) -> None:
        """use.actions 走的是**共享**的 `walk_action_defs_embedded_refs`。

        用 `chooseAction` 取样：参数级的覆盖面由那只共享 walker 的动作白名单决定
        （`showNotification.text` 等就不在白名单里——那是全项目所有动作树一视同仁的
        既有缺口，见 _meta/inbox 偏差记录，不是物件独有）。这里要钉住的是**接线**：
        物件用途的动作树确实被送进了那只 walker，而不是压根没人扫。
        """
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            item = _full_item()
            item["use"]["actions"] = [
                {"type": "chooseAction",
                 "params": {"prompt": "坏 [tag:item:__definitely_missing__]", "options": []}},
            ]
            model.items = [item]
            err = validate_refs_for_save(model, dirty={"item"})
            self.assertTrue(err, "use.actions 里的悬垂引用必须被拦下")
            self.assertIn("use.actions", err)

    def test_dangling_ref_inside_nested_use_actions_is_caught(self) -> None:
        """嵌套容器（runActions）里的引用同样要扫到——物件用途允许嵌套动作。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            item = _full_item()
            item["use"]["actions"] = [{
                "type": "runActions",
                "params": {"actions": [
                    {"type": "chooseAction",
                     "params": {"prompt": "坏 [tag:item:__definitely_missing__]", "options": []}},
                ]},
            }]
            model.items = [item]
            err = validate_refs_for_save(model, dirty={"item"})
            self.assertTrue(err)
            self.assertIn("use.actions", err)


class ItemUseActionRegistryScanTests(unittest.TestCase):
    """items[].use.actions 必须进动作总表，否则改信号名时扫不到物件里那条。"""

    def test_scan_picks_up_item_use_actions(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.items = [_full_item()]
            records = _scan_actions(model)
            hits = [r for r in records if r.source_type == "item"]
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0].action_type, "playSfx")
            self.assertEqual(hits[0].source_id, "i_full")
            self.assertTrue(hits[0].navigable, "ItemEditor 有 select_by_id，应可跳转")


if __name__ == "__main__":
    unittest.main()
