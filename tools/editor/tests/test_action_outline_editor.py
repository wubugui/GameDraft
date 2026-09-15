"""动作大纲编辑器（叙事状态机「进入时动作」等入口的原生动作编辑窗）护栏。

制作人 2026-09-14 打回旧形态：内联 ActionEditor 平铺进无滚动对话框，一条带长条件的
runActionsIf 就把整个窗口占满、后面的动作全看不见、也没法折叠。这里钉住：

- **任意复杂度不撑窗口**：巨型条件 + 几十条嵌套动作，对话框最小高度仍是常数级，
  大纲树行数 = 结构节点数，条件在检查器里滚而不是把窗口顶高；
- **只看不改 = 逐字返回**：合成的全容器 fixture 与叙事图真实数据，逐行点一遍后原样；
- 检查器编辑 / 结构操作 / 拖拽 / 剪贴板 / 撤销重做走真实入口，数据按预期变化；
- 容器登记表与运行时 ActionRegistry.ts 的容器动作一致（唯一真相源的 parity）；
- 内联 ActionEditor：条件块默认折叠懒建且往返保真、「大纲…」入口写回、行尾按钮看得见；
- 叙事桥 editActions 走大纲窗、非对象条目不再被静默丢掉。
"""
from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QMimeData, QPoint, Qt
from PySide6.QtGui import QDragMoveEvent, QDropEvent
from PySide6.QtWidgets import QAbstractItemView, QApplication, QDialog, QToolButton

from tools.editor.shared.action_editor import ActionEditor, ActionRow
from tools.editor.shared.action_outline_editor import ActionOutlineDialog, ActionOutlineEditor
from tools.editor.shared.action_structure import (
    NESTED_ACTION_SLOTS,
    flatten_actions,
    summarize_action,
    summarize_condition,
)
from tools.editor.shared.condition_expr_tree import ConditionExprNodeEditor, ConditionExprTreeRootWidget

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def app():
    return QApplication.instance() or QApplication([])


def _long_condition(groups: int) -> dict:
    return {
        "any": [
            {"all": [{"flag": f"rule_{i}_acquired"}, {"not": {"flag": f"has_item_{i}"}}]}
            for i in range(groups)
        ]
    }


def _fixture_all_containers() -> list:
    return [
        {
            "type": "runActionsIf",
            "params": {
                "condition": _long_condition(4),
                "actions": [{"type": "setFlag", "params": {"key": "a", "value": True}}],
            },
        },
        {"type": "showNotification", "params": {"text": "后面的动作", "type": "info"}},
        {
            "type": "randomBranch",
            "params": {
                "probability": 0.3,
                "aboveActions": [{"type": "waitMs", "params": {"durationMs": 200}}],
                "belowActions": [
                    {
                        "type": "runActionsIf",
                        "params": {
                            "condition": {"quest": "q_demo", "questStatus": "Active"},
                            "actions": [{"type": "playSfx", "params": {"id": "sfx_x"}}],
                            "elseActions": [],
                        },
                    }
                ],
            },
        },
        {
            "type": "chooseAction",
            "params": {
                "prompt": "怎么办？",
                "options": [
                    {"text": "进去", "actions": [{"type": "addFlagValue", "params": {"key": "c", "delta": 1}}],
                     "futureKey": {"keep": 1}},
                    {"text": "走开", "actions": []},
                ],
            },
        },
        {"type": "runActions", "params": {"actions": [{"type": "endDay", "params": {}}]}},
        {"type": "addDelayedEvent", "params": {"targetDay": 3, "actions": [{"type": "openMap"}]}},
        {
            "type": "enableRuleOffers",
            "params": {"slots": [{"ruleId": "r1", "resultText": "x", "resultActions": [], "requiredLayers": ["li"]}]},
        },
        "not-an-object",
        {"type": "someFutureAction", "params": {"weird": [1, 2]}, "comment": "top-level extra key"},
    ]


def _visit_every_node(app, ed: ActionOutlineEditor) -> None:
    for item in list(ed._items):
        ed.tree().setCurrentItem(item)
        app.processEvents()


def _select(ed: ActionOutlineEditor, path: tuple) -> None:
    ed.tree().setCurrentItem(ed._items[ed._index_by_path[path]])


# ---------------------------------------------------------------------- 结构登记表 parity


def test_slot_registry_matches_runtime_containers():
    """运行时里所有嵌套执行动作列表的 register() 都必须在登记表里、且参数键对得上。"""
    text = (REPO / "src/core/ActionRegistry.ts").read_text("utf-8")
    containers: dict[str, set[str]] = {}
    for m in re.finditer(r"executor\.register\('(\w+)'", text):
        name = m.group(1)
        end = text.find("executor.register(", m.end())
        block = text[m.start(): end if end > 0 else len(text)]
        if "actionListFromParam" not in block and name != "addDelayedEvent":
            continue
        tail = re.search(r"\},\s*\[([^\]]*)\]\);", block)
        params = set(re.findall(r"'(\w+)'", tail.group(1))) if tail else set()
        containers[name] = {p for p in params if p.lower().endswith("actions") or p == "options"}
    assert {"runActions", "chooseAction", "randomBranch", "runActionsIf", "addDelayedEvent"} <= set(containers)
    for name, keys in containers.items():
        assert name in NESTED_ACTION_SLOTS, f"{name} 嵌套执行子动作，却没登记进 NESTED_ACTION_SLOTS"
        assert {s.key for s in NESTED_ACTION_SLOTS[name]} == keys, name
    # enableRuleOffers 的槽位 resultActions 由规矩面执行，不走 actionListFromParam。
    assert [s.item_actions_key for s in NESTED_ACTION_SLOTS["enableRuleOffers"]] == ["resultActions"]


def test_flatten_covers_every_container_including_run_actions_if():
    flat = flatten_actions(_fixture_all_containers())
    paths = [p for p, _ in flat]
    assert "[0].actions[0]" in paths
    assert "[2].belowActions[0].actions[0]" in paths
    assert "[3].options[0].actions[0]" in paths
    assert "[5].actions[0]" in paths


def test_action_registry_page_counts_run_actions_if_children():
    from tools.editor.editors.action_registry_editor import _flatten_actions

    got = [p for p, _ in _flatten_actions(_fixture_all_containers(), "x")]
    assert "x[0].actions[0]" in got, "动作登记表页漏了 runActionsIf 的子动作"


def test_condition_summary_is_precise():
    s = summarize_condition(_long_condition(2))
    assert s == "(rule_0_acquired 且 非 has_item_0) 或 (rule_1_acquired 且 非 has_item_1)"
    assert summarize_condition({"flag": "k", "op": ">=", "value": 3}) == "k >= 3"
    assert summarize_condition({"flag": "k", "value": False}) == "k == false"
    assert "恒假" in summarize_condition({"not": {"all": []}})
    assert summarize_action({"type": "runActionsIf", "params": {}}) == "无条件（恒真）"


# ---------------------------------------------------------------------- 往返保真


def test_view_only_returns_input_verbatim(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.resize(1100, 700)
    ed.show()
    _visit_every_node(app, ed)
    assert ed.to_list() == data
    assert not ed.is_modified()
    ed.deleteLater()


def test_real_narrative_action_lists_view_only_roundtrip(app):
    from tools.editor.project_model import ProjectModel

    model = ProjectModel()
    model.load_project(REPO)
    graphs = json.loads((REPO / "public/assets/data/narrative_graphs.json").read_text("utf-8"))
    lists: list[list] = []

    def walk(x):
        if isinstance(x, dict):
            for k in ("onEnterActions", "onExitActions"):
                if isinstance(x.get(k), list) and x[k]:
                    lists.append(x[k])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(graphs)
    assert lists, "真实数据里应有进入/离开动作"
    for acts in lists:
        ed = ActionOutlineEditor("real", deepcopy(acts), model=model)
        ed.resize(1100, 700)
        ed.show()
        _visit_every_node(app, ed)
        assert ed.to_list() == acts
        assert not ed.is_modified()
        ed.deleteLater()


# ---------------------------------------------------------------------- 任意复杂度不撑窗口


def test_monster_content_does_not_grow_dialog(app):
    body = [{"type": "setFlag", "params": {"key": f"k{i}", "value": True}} for i in range(30)]
    monster = [
        {"type": "runActionsIf", "params": {"condition": _long_condition(20), "actions": body, "elseActions": body[:5]}},
        *body,
    ]
    dlg = ActionOutlineDialog("monster", monster, geometry_key="test_outline_monster")
    dlg.resize(900, 600)
    dlg.show()
    app.processEvents()
    assert dlg.minimumSizeHint().height() < 520, "内容再复杂，对话框最小高度也必须是常数级"
    ed = dlg.editor()
    assert ed.tree().topLevelItemCount() == 31, "顶层每条动作一行，一条都不能被挤出去"
    _select(ed, (0,))
    for _ in range(6):
        app.processEvents()
    sb = ed._inspector_scroll.verticalScrollBar()
    assert sb.maximum() > 0, "长条件应在检查器里滚动，而不是把窗口顶高"
    assert dlg.height() <= 620
    dlg._confirm_discard = lambda: True
    dlg.reject()


def test_condition_collapse_turns_tree_into_summary(app):
    data = [{"type": "runActionsIf", "params": {"condition": _long_condition(6), "actions": []}}]
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.resize(1100, 700)
    ed.show()
    _select(ed, (0,))
    app.processEvents()
    cond = ed._inspector_row._cond_if_expr
    assert isinstance(cond, ConditionExprTreeRootWidget)
    tall = cond.sizeHint().height()
    cond.collapse_all()
    app.processEvents()
    assert cond.sizeHint().height() < tall / 4
    assert cond.root_node()._summary.isVisible()
    assert "rule_5_acquired" in cond.root_node()._summary.text()
    cond.collapse_to_skeleton()
    app.processEvents()
    groups = [n for n in cond.root_node().findChildren(ConditionExprNodeEditor) if n._active_kind == "all"]
    assert groups and all(n.is_collapsed() for n in groups)
    assert ed.to_list() == data, "折叠/展开是阅读状态，不能改数据"
    ed.deleteLater()


# ---------------------------------------------------------------------- 检查器编辑 / 撤销


def test_inspector_edit_commits_and_undo_redo(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    _select(ed, (0, ("s", "actions"), 0))  # runActionsIf › 满足时 › setFlag
    app.processEvents()
    row = ed._inspector_row
    assert isinstance(row, ActionRow)
    row._param_widgets["key"].set_key("edited_key")
    app.processEvents()
    out = ed.to_list()
    assert out[0]["params"]["actions"][0]["params"]["key"] == "edited_key"
    assert out[0]["params"]["condition"] == data[0]["params"]["condition"]
    assert out[1:] == data[1:]
    assert ed.is_modified()
    assert "edited_key" in ed._items[ed._index_by_path[(0, ("s", "actions"), 0)]].text(1)
    ed.undo()
    assert ed.to_list() == data and not ed.is_modified()
    ed.redo()
    assert ed.to_list()[0]["params"]["actions"][0]["params"]["key"] == "edited_key"
    ed.deleteLater()


def test_editing_container_condition_keeps_children_identity(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    _select(ed, (0,))
    app.processEvents()
    child_before = ed._actions[0]["params"]["actions"][0]
    cond = ed._inspector_row._cond_if_expr
    first_leaf = next(n for n in cond.root_node().findChildren(ConditionExprNodeEditor) if n._active_kind == "flag")
    first_leaf._flag_field.set_key("changed_flag")
    app.processEvents()
    out = ed.to_list()
    assert out[0]["params"]["condition"]["any"][0]["all"][0] == {"flag": "changed_flag"}
    assert ed._actions[0]["params"]["actions"][0] is child_before, "子列表必须换回活对象，大纲节点挂在它们身上"
    assert out[0]["params"]["actions"] == data[0]["params"]["actions"]
    assert "changed_flag" in ed._items[ed._index_by_path[(0,)]].text(1)
    ed.deleteLater()


def test_type_switch_in_inspector_drops_children_and_is_undoable(app, monkeypatch):
    monkeypatch.setattr(ActionRow, "_confirm_type_switch_clear", lambda *a, **k: True)
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    _select(ed, (4,))  # runActions
    app.processEvents()
    ed._inspector_row.type_combo._apply_committed("setFlag")
    app.processEvents()
    out = ed.to_list()
    assert out[4]["type"] == "setFlag"
    assert "actions" not in out[4]["params"]
    assert (4, ("s", "actions"), 0) not in ed._index_by_path
    ed.undo()
    assert ed.to_list() == data
    ed.deleteLater()


def test_option_text_edit(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    path = (3, ("s", "options"), ("i", 0))
    _select(ed, path)
    app.processEvents()
    from PySide6.QtWidgets import QLineEdit

    edit = [w for w in ed._inspector_body.findChildren(QLineEdit) if w.text() == "进去"][0]
    edit.setText("冲进去")
    out = ed.to_list()
    assert out[3]["params"]["options"][0] == {**data[3]["params"]["options"][0], "text": "冲进去"}
    ed.deleteLater()


# ---------------------------------------------------------------------- 结构操作


def test_add_into_absent_else_branch_and_cancel_leaves_no_key(app, monkeypatch):
    data = [{"type": "runActionsIf", "params": {"condition": {"flag": "x"}, "actions": []}}]
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    slot = NESTED_ACTION_SLOTS["runActionsIf"][1]
    monkeypatch.setattr(ed, "_pick_action_type", lambda: "")
    ed._add_into_slot(ed._nodes[ed._index_by_path[(0,)]], slot)
    assert ed.to_list() == data, "取消选择类型时不能凭空多出 elseActions 键"
    monkeypatch.setattr(ed, "_pick_action_type", lambda: "setFlag")
    ed._add_into_slot(ed._nodes[ed._index_by_path[(0,)]], slot)
    out = ed.to_list()
    assert out[0]["params"]["elseActions"][0]["type"] == "setFlag"
    assert ed.selected_node().path == (0, ("s", "elseActions"), 0)
    ed.undo()
    assert ed.to_list() == data
    ed.deleteLater()


def test_new_action_materializes_like_inline_editor(app, monkeypatch):
    ed = ActionOutlineEditor("t", [])
    monkeypatch.setattr(ed, "_pick_action_type", lambda: "giveItem")
    ed._add_default()
    inline = ActionEditor("x")
    inline.set_data([{"type": "giveItem", "params": {}}])
    assert ed.to_list() == inline.to_list()
    ed.deleteLater()
    inline.deleteLater()


def test_delete_duplicate_move_keyboard_shortcuts(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.resize(1000, 700)
    ed.show()
    ed.tree().setFocus()
    _select(ed, (1,))
    app.processEvents()
    from PySide6.QtTest import QTest

    QTest.keyClick(ed.tree(), Qt.Key.Key_D, Qt.KeyboardModifier.ControlModifier)
    assert ed.to_list()[2] == data[1] and len(ed.to_list()) == len(data) + 1
    QTest.keyClick(ed.tree(), Qt.Key.Key_Up, Qt.KeyboardModifier.AltModifier)
    assert ed.selected_node().path == (1,)
    QTest.keyClick(ed.tree(), Qt.Key.Key_Delete)
    assert ed.to_list() == data
    QTest.keyClick(ed.tree(), Qt.Key.Key_Z, Qt.KeyboardModifier.ControlModifier)
    assert len(ed.to_list()) == len(data) + 1
    ed.deleteLater()


def test_cut_paste_moves_action_into_branch(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    _select(ed, (1,))
    ed._cut_selected()
    _select(ed, (1, ("s", "aboveActions")))  # randomBranch 下移到 (1,) 后的「分支 A」
    ed._paste()
    out = ed.to_list()
    assert data[1] not in out
    assert out[1]["params"]["aboveActions"][-1] == data[1]
    ed.deleteLater()


def test_drop_via_real_drag_events_into_branch(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.resize(1100, 800)
    ed.show()
    app.processEvents()
    tree = ed.tree()
    src_item = ed._items[ed._index_by_path[(1,)]]
    tgt_item = ed._items[ed._index_by_path[(0, ("s", "actions"))]]  # runActionsIf ›「满足时」分支行
    tree.setCurrentItem(src_item)
    mime: QMimeData = tree.mimeData([src_item])
    rect = tree.visualItemRect(tgt_item)
    pos = rect.center()
    actions = Qt.DropAction.MoveAction
    move = QDragMoveEvent(pos, actions, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    QApplication.sendEvent(tree.viewport(), move)
    assert tree.dropIndicatorPosition() == QAbstractItemView.DropIndicatorPosition.OnItem
    drop = QDropEvent(pos.toPointF(), actions, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    # 拖动走真实事件分发（落点指示由 Qt 自己的 dragMoveEvent 算）；放下直接调视图的 dropEvent：
    # 离屏没有进行中的 QDrag，QApplication::notify 不把 Drop 投给视口（实测 sendEvent 返回 False）。
    tree.dropEvent(drop)
    assert drop.dropAction() == Qt.DropAction.IgnoreAction, "Qt 不许自己搬行（MoveAction 会删源行）"
    for _ in range(3):
        app.processEvents()
    out = ed.to_list()
    assert data[1] not in out
    assert out[0]["params"]["actions"][-1] == data[1]
    ed.deleteLater()


def test_cannot_drop_container_into_itself(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    on = int(QAbstractItemView.DropIndicatorPosition.OnItem.value)
    assert not ed.perform_drop((2,), (2, ("s", "belowActions")), on)
    assert not ed.perform_drop((2,), (2, ("s", "belowActions"), 0), on)
    assert ed.to_list() == data
    ed.deleteLater()


def test_reorder_options_by_drop(app):
    data = _fixture_all_containers()
    ed = ActionOutlineEditor("t", deepcopy(data))
    ed.show()
    below = int(QAbstractItemView.DropIndicatorPosition.BelowItem.value)
    assert ed.perform_drop((3, ("s", "options"), ("i", 0)), (3, ("s", "options"), ("i", 1)), below)
    opts = ed.to_list()[3]["params"]["options"]
    assert [o["text"] for o in opts] == ["走开", "进去"]
    assert opts[1]["futureKey"] == {"keep": 1}
    ed.deleteLater()


def test_dialog_reject_confirms_only_when_modified(app):
    dlg = ActionOutlineDialog("t", [{"type": "setFlag", "params": {"key": "a", "value": True}}],
                              geometry_key="test_outline_reject")
    asked: list[bool] = []
    dlg._confirm_discard = lambda: asked.append(True) or False
    dlg.reject()
    assert not asked and dlg.result() == QDialog.DialogCode.Rejected
    dlg2 = ActionOutlineDialog("t", [{"type": "setFlag", "params": {"key": "a", "value": True}}],
                               geometry_key="test_outline_reject")
    dlg2.editor()._duplicate_selected()
    dlg2._confirm_discard = lambda: asked.append(True) or False
    dlg2.show()
    dlg2.reject()
    assert asked and dlg2.isVisible(), "有改动且没确认放弃时不能关窗"
    dlg2._confirm_discard = lambda: True
    dlg2.reject()
    assert not dlg2.isVisible()


# ---------------------------------------------------------------------- 内联 ActionEditor


def test_inline_condition_section_is_lazy_and_roundtrips(app):
    data = [
        {"type": "runActionsIf", "params": {"condition": _long_condition(8), "actions": [
            {"type": "setFlag", "params": {"key": "a", "value": True}}]}},
        {"type": "setFlag", "params": {"key": "b", "value": True}},
    ]
    ae = ActionEditor("onEnter")
    ae.set_data(deepcopy(data))
    ae.resize(520, 400)
    ae.show()
    row = ae._rows[0]
    row.restore_fold_state(False)
    app.processEvents()
    assert row._cond_if_expr is None, "有条件时条件块默认折叠、不建控件树"
    assert "rule_7_acquired" in row._cond_if_section._header.toolTip()
    assert "rule_0_acquired" in row._cond_if_section._plain_title
    assert ae.to_list() == data
    row._cond_if_section.set_expanded(True)
    app.processEvents()
    assert isinstance(row._cond_if_expr, ConditionExprTreeRootWidget)
    assert ae.to_list() == data
    ae.deleteLater()


def test_inline_collapsed_row_shows_summary_and_visible_glyph_buttons(app):
    ae = ActionEditor("onEnter")
    ae.set_data([{"type": "setFlag", "params": {"key": "demo", "value": True}},
                 {"type": "playSfx", "params": {"id": "sfx_door"}}])
    ae.show()
    app.processEvents()
    row = ae._rows[0]
    assert row._summary_label.isVisible() and "demo" in row._summary_label.text()
    assert isinstance(row.del_btn, QToolButton) and isinstance(row._btn_up, QToolButton)
    row.restore_fold_state(False)
    assert not row._summary_label.isVisible()
    ae.deleteLater()


def test_inline_outline_button_writes_back_only_on_change(app, monkeypatch):
    data = [{"type": "setFlag", "params": {"key": "a", "value": True}}]
    ae = ActionEditor("onEnter")
    ae.set_data(deepcopy(data))
    fired: list[int] = []
    ae.changed.connect(lambda: fired.append(1))

    def fake_exec(self):
        return QDialog.DialogCode.Accepted

    monkeypatch.setattr(ActionOutlineDialog, "exec", fake_exec)
    ae.open_outline_editor()
    assert not fired and ae.to_list() == data

    def fake_exec_edit(self):
        self.editor()._duplicate_selected()
        return QDialog.DialogCode.Accepted

    monkeypatch.setattr(ActionOutlineDialog, "exec", fake_exec_edit)
    ae.open_outline_editor()
    assert fired and ae.to_list() == data * 2
    ae.deleteLater()


def test_nested_inline_editors_have_no_outline_button(app):
    ae = ActionEditor("onEnter")
    ae.set_data([{"type": "runActions", "params": {"actions": [{"type": "endDay", "params": {}}]}}])
    assert ae._btn_outline is not None
    nested = ae._rows[0]._run_actions_editor
    assert nested is not None and nested._btn_outline is None
    ae.deleteLater()


# ---------------------------------------------------------------------- 条件树


def test_condition_add_child_goes_before_add_button(app):
    root = ConditionExprTreeRootWidget(model_getter=lambda: None)
    root.set_expr({"all": [{"flag": "a"}]})
    node = root.root_node()
    node._add_child()
    lay = node._lay_all_any
    last = lay.itemAt(lay.count() - 1).widget()
    assert last is not None and last.text() == "+ 添加子条件"
    assert len(node._child_editors) == 2
    root.deleteLater()


def test_condition_inline_policy_is_uniform_across_tree(app):
    from PySide6.QtWidgets import QScrollArea

    area = QScrollArea()
    area.setWidgetResizable(True)
    root = ConditionExprTreeRootWidget(model_getter=lambda: None, scroll_mode="none")
    root.set_expr(_long_condition(3))
    area.setWidget(root)
    area.resize(1600, 900)
    area.show()
    for _ in range(4):
        app.processEvents()
    root.apply_inline_policy()
    leaves = [n for n in root.root_node().findChildren(ConditionExprNodeEditor) if n._active_kind == "flag"]
    assert leaves and all(n.is_inline() for n in leaves)
    area.resize(360, 900)
    for _ in range(4):
        app.processEvents()
    root.apply_inline_policy()
    assert all(not n.is_inline() for n in leaves), "窄宿主必须整棵退回上下排"
    assert root.get_expr() == _long_condition(3)
    area.deleteLater()


# ---------------------------------------------------------------------- 叙事桥


def test_narrative_bridge_edit_actions_uses_outline_dialog(app, monkeypatch):
    from tools.editor.editors import narrative_state_editor as nse

    bridge_cls = next(
        c for c in vars(nse).values()
        if isinstance(c, type) and hasattr(c, "editActions") and hasattr(c, "editConditions")
    )
    bridge = bridge_cls.__new__(bridge_cls)
    bridge._model = None
    monkeypatch.setattr(bridge_cls, "parent", lambda self: None, raising=False)
    payload = [{"type": "setFlag", "params": {"key": "a", "value": True}}, "raw-string-entry"]
    seen: dict = {}

    def fake_exec(self):
        seen["tree_rows"] = self.editor().tree().topLevelItemCount()
        return QDialog.DialogCode.Accepted

    monkeypatch.setattr(ActionOutlineDialog, "exec", fake_exec)
    res = json.loads(bridge_cls.editActions(bridge, "onEnterActions", json.dumps(payload)))
    assert res == {"ok": True, "actions": payload}, "非对象条目也必须原样返回，不再被静默丢弃"
    assert seen["tree_rows"] == 2
    monkeypatch.setattr(ActionOutlineDialog, "exec", lambda self: QDialog.DialogCode.Rejected)
    res = json.loads(bridge_cls.editActions(bridge, "onEnterActions", json.dumps(payload)))
    assert res == {"ok": False, "reason": "cancelled"}


def test_narrative_bridge_summarize_actions_outline_rows():
    from tools.editor.editors import narrative_state_editor as nse

    bridge_cls = next(
        c for c in vars(nse).values()
        if isinstance(c, type) and hasattr(c, "summarizeActions") and hasattr(c, "editActions")
    )
    bridge = bridge_cls.__new__(bridge_cls)
    res = json.loads(bridge_cls.summarizeActions(bridge, json.dumps(_fixture_all_containers())))
    assert res["ok"] and res["total"] == len(flatten_actions(_fixture_all_containers()))
    rows = res["rows"]
    first = rows[0]
    assert first == {"depth": 0, "kind": "action", "type": "runActionsIf", "label": "1. runActionsIf",
                     "summary": summarize_action(_fixture_all_containers()[0])}
    assert rows[1] == {"depth": 1, "kind": "slot", "label": "满足时", "summary": "1 条"}
    assert rows[2]["depth"] == 2 and rows[2]["label"] == "1. setFlag"
    # 单子列表容器（chooseAction）：选项直接挂在动作下，不多一层分支行
    choose = next(i for i, r in enumerate(rows) if r.get("type") == "chooseAction")
    assert rows[choose + 1]["kind"] == "item" and rows[choose + 1]["depth"] == rows[choose]["depth"] + 1
    assert any(r["kind"] == "bad" for r in rows)
    # 叫法与原生大纲窗一致
    ed = ActionOutlineEditor("t", _fixture_all_containers())
    labels = [it.text(0) for it in ed._items]
    assert [r["label"] for r in rows] == [lb.replace("（未登记）", "") for lb in labels]
    ed.deleteLater()
