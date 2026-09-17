"""手持挂件条件叶 `{heldProp, socket?, prop?, propState?, burning?, vitalityOp?+vitality?, lock?}` 的编辑器侧登记面。

运行时权威：`src/data/types.ts::HeldPropConditionLeaf`、`src/systems/graphDialogue/evaluateGraphCondition.ts`
（`isHeldPropLeaf` / `heldPropMismatch` / `HELD_VITALITY_OPS`）。覆盖（每条对应一个"漏了会静默"的口子）：

1. 镜像对账：叶子字段 / lock 三档 / 火势运算符，编辑器 ↔ 校验器 ↔ TS 三处同一份。
2. 条件树：打开→不动→导出逐字节（含怪值、悬垂引用、不认识的键、嵌在 not 里）；从控件入口改一项
   只动那一项；不限 = 不写键；程序性载入 / 刷新不外发 changed；引用字段不是裸 QLineEdit、候选 = 校验面。
3. 人话摘要：图对话 / 动作大纲 / 信号关系三处。
4. 校验器：好形态干净、每条护栏先改坏一次；现网数据里的叶子不报。
5. json_lang：叶子已建模（无 tripwire）、schema 认好形态、拦坏形态。
6. 挂件预设改名 / 引用扫描跟到条件叶。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QDialog, QLineEdit  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import condition_expr_tree as cet  # noqa: E402
from tools.editor.shared.condition_editor import ConditionEditor  # noqa: E402
from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget  # noqa: E402
from tools.editor.shared.reference_picker import ReferencePickerField  # noqa: E402

FULL = {
    "heldProp": "player", "socket": "right_hand", "prop": "xianteng_torch", "propState": "lit",
    "burning": True, "vitalityOp": "<", "vitality": 0.3, "lock": "lit",
}


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app) -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
    return m


def _preset_with_states(model: ProjectModel) -> tuple[str, list[str]]:
    for pid, entry in model.prop_presets.items():
        if isinstance(entry, dict) and isinstance(entry.get("states"), dict) and entry["states"]:
            return str(pid), [str(k) for k in entry["states"]]
    pytest.skip("仓库里没有带状态表的挂件预设")


def _full(model: ProjectModel) -> dict:
    pid, states = _preset_with_states(model)
    return {**FULL, "prop": pid, "propState": states[0]}


# =========================================================================== #
# 1. 镜像对账
# =========================================================================== #

def _ts_leaf_body() -> str:
    text = (_ROOT / "src/data/types.ts").read_text("utf-8")
    m = re.search(r"export interface HeldPropConditionLeaf \{(?P<body>.*?)\n\}", text, re.S)
    assert m, "types.ts 里没有 HeldPropConditionLeaf"
    return m.group("body")


def test_leaf_fields_match_runtime_type() -> None:
    fields = re.findall(r"^\s*(\w+)\??:", _ts_leaf_body(), re.M)
    assert tuple(fields) == cet._HELD_PROP_KEYS, fields


def test_lock_values_match_runtime_type_and_validator() -> None:
    from tools.editor.validator import _PROP_LOCK_VALUES

    m = re.search(r"lock\?:\s*([^;]+);", _ts_leaf_body())
    ts = set(re.findall(r"'(\w+)'", m.group(1)))
    assert ts == set(_PROP_LOCK_VALUES) == {v for v, _l in cet._HELD_LOCK_ROWS}


def test_vitality_ops_match_runtime_and_validator() -> None:
    from tools.editor.validator import _HELD_VITALITY_OPS

    m = re.search(r"vitalityOp\?:\s*([^;]+);", _ts_leaf_body())
    ts = set(re.findall(r"'([<>=]+)'", m.group(1)))
    ev = (_ROOT / "src/systems/graphDialogue/evaluateGraphCondition.ts").read_text("utf-8")
    block = re.search(r"const HELD_VITALITY_OPS[^{]*\{(?P<b>.*?)\};", ev, re.S)
    runtime = set(re.findall(r"'([<>=]+)'\s*:", block.group("b")))
    assert ts == runtime == set(_HELD_VITALITY_OPS) == set(cet._HELD_VITALITY_OPS)


# =========================================================================== #
# 2. 条件树
# =========================================================================== #

def _roundtrip(model: ProjectModel, conditions: list[dict]) -> list[dict]:
    ed = ConditionEditor()
    ed.set_flag_pattern_context(model, None)
    ed.set_data(copy.deepcopy(conditions))
    try:
        return ed.to_list()
    finally:
        ed.deleteLater()


@pytest.mark.parametrize("leaf", [
    {"heldProp": "player"},
    {"heldProp": "player", "socket": "right_hand", "burning": True},
    {"heldProp": "player", "burning": False, "lock": "none"},
    {"heldProp": "player", "vitalityOp": ">=", "vitality": 0},
    {"heldProp": "绝不存在的人", "prop": "绝不存在的挂件", "propState": "绝不存在的状态", "socket": "绝不存在的挂点"},
    # 运行时不认的怪值 / 落单的一半 / 不认识的键：没动过就原样留着
    {"备注": [1], "heldProp": " player ", "prop": 5, "propState": 3, "burning": "yes",
     "vitalityOp": "==", "vitality": "0.3", "lock": "locked", "socket": None},
    {"heldProp": "player", "vitality": 0.33333333},
    {"heldProp": "player", "vitalityOp": "<"},
    {"heldProp": "player", "lock": ""},
])
def test_leaf_roundtrips_byte_for_byte(model, leaf) -> None:
    for conds in ([leaf], [{"not": leaf}], [{"any": [{"flag": "f"}, leaf]}]):
        out = _roundtrip(model, conds)
        assert json.dumps(out, ensure_ascii=False) == json.dumps(conds, ensure_ascii=False)


def test_full_real_leaf_roundtrips(model) -> None:
    leaf = _full(model)
    assert _roundtrip(model, [leaf]) == [leaf]


def _tree(model: ProjectModel, expr: dict | None) -> ConditionExprTreeRootWidget:
    tree = ConditionExprTreeRootWidget(model_getter=lambda: model)
    tree.set_expr(expr)
    return tree


def test_programmatic_load_and_refresh_do_not_emit(model) -> None:
    tree = _tree(model, None)
    try:
        got: list[int] = []
        tree.changed.connect(lambda: got.append(1))
        leaf = _full(model)
        tree.set_expr(leaf)
        tree.set_model_refresh()
        assert got == [] and tree.get_expr() == leaf
    finally:
        tree.deleteLater()


class _Picker:
    """ReferencePickerDialog 替身：记下候选、选定 `pick`（离屏下真弹窗 exec() 永不返回）。"""

    rows: list = []
    pick = ""

    def __init__(self, rows, *_a, **_kw) -> None:
        type(self).rows = list(rows)

    def exec(self):
        return QDialog.DialogCode.Accepted

    def selected_value(self) -> str:
        return type(self).pick


def _choose(field: ReferencePickerField, value: str) -> list:
    _Picker.pick = value
    with patch("tools.editor.shared.reference_picker.ReferencePickerDialog", _Picker):
        field._choose.click()
    return _Picker.rows


def test_new_leaf_from_the_type_dropdown_writes_only_what_was_set(model) -> None:
    pid, states = _preset_with_states(model)
    tree = _tree(model, None)
    try:
        root = tree.root_node()
        got: list[int] = []
        tree.changed.connect(lambda: got.append(1))
        root._kind.setCurrentIndex(root._kind.findData("heldProp"))
        assert tree.get_expr() is None, "没选人就不是一条条件"

        rows = _choose(root._hp_who, "player")
        assert [r[0] for r in rows] == [r[0] for r in model.held_prop_holder_items()], "候选 = 校验面"
        assert tree.get_expr() == {"heldProp": "player"}, "没动的可选项一律不写"
        assert got, "用户选人要外发 changed"

        socket_values = {v for _l, v in root._hp_socket._entries}
        assert {n for n, _l in model.socket_names_for_holder_any_scene("player")} <= socket_values
        root._hp_socket.set_committed_type("right_hand", emit=True)

        rows = _choose(root._hp_prop, pid)
        assert {r[0] for r in rows} == {p for p, _l in model.all_prop_preset_ids()}
        state_values = [root._hp_state.itemData(i) for i in range(root._hp_state.count())]
        assert state_values == ["", *states], "选了挂件：状态候选 = 这件预设的 states（校验器同口径）"
        root._hp_state.setCurrentIndex(root._hp_state.findData(states[-1]))
        root._hp_burning.setCurrentIndex(root._hp_burning.findData("true"))
        assert not root._hp_vitality.isEnabled(), "没选运算符，阈值不可编辑"
        root._hp_op.setCurrentIndex(root._hp_op.findData("<"))
        assert root._hp_vitality.isEnabled()
        root._hp_vitality.setValue(0.3)
        root._hp_lock.setCurrentIndex(root._hp_lock.findData("unlit"))
        assert tree.get_expr() == {
            "heldProp": "player", "socket": "right_hand", "prop": pid, "propState": states[-1],
            "burning": True, "vitalityOp": "<", "vitality": 0.3, "lock": "unlit",
        }
        # 选回「不限」= 删键；火势是一对，一起删
        root._hp_op.setCurrentIndex(root._hp_op.findData(""))
        root._hp_burning.setCurrentIndex(root._hp_burning.findData(""))
        root._hp_lock.setCurrentIndex(root._hp_lock.findData(""))
        assert tree.get_expr() == {"heldProp": "player", "socket": "right_hand", "prop": pid,
                                   "propState": states[-1]}
    finally:
        tree.deleteLater()


def test_editing_one_field_keeps_every_other_raw_value(model) -> None:
    raw = {"备注": "留着", "heldProp": "player", "prop": "绝不存在的挂件", "propState": "ghost",
           "burning": "yes", "vitality": 0.33333333, "lock": "locked"}
    tree = _tree(model, raw)
    try:
        root = tree.root_node()
        # 悬垂状态保值展示，不顶替成第一项
        assert root._hp_state.currentData() == "ghost" and "不在候选里" in root._hp_state.currentText()
        assert root._hp_lock.currentData() == cet._HP_RAW and "locked" in root._hp_lock.currentText()
        root._hp_socket.set_committed_type("right_hand", emit=True)
        assert tree.get_expr() == {**raw, "socket": "right_hand"}
        root._hp_op.setCurrentIndex(root._hp_op.findData(">="))
        out = tree.get_expr()
        assert out["vitalityOp"] == ">=" and out["vitality"] == 0.33333333, "阈值没动：原表示回吐，不被 spinbox 截断"
        root._hp_vitality.setValue(0.25)
        assert tree.get_expr()["vitality"] == 0.25
        # 换挂件：已选状态名保值（不静默清空）
        _choose(root._hp_prop, _preset_with_states(model)[0])
        assert tree.get_expr()["propState"] == "ghost"
    finally:
        tree.deleteLater()


def test_reference_fields_follow_the_selector_rule(model) -> None:
    from tools.editor.shared.action_editor import FilterableTypeCombo

    tree = _tree(model, _full(model))
    try:
        root = tree.root_node()
        assert isinstance(root._hp_who, ReferencePickerField)
        assert isinstance(root._hp_prop, ReferencePickerField)
        assert isinstance(root._hp_socket, FilterableTypeCombo), "挂点照 attachToSocket.socket 的约定：可筛选下拉"
        for w in (root._hp_state, root._hp_burning, root._hp_op, root._hp_lock):
            assert type(w) is not QLineEdit and not w.isEditable(), "短枚举只许选，不许手输"
        assert [root._hp_burning.itemData(i) for i in range(root._hp_burning.count())] == ["", "true", "false"]
        assert {root._hp_lock.itemData(i) for i in range(root._hp_lock.count())} == {"", "lit", "unlit", "none"}
        assert "否定(not)" in root._hp_wrap.toolTip()
    finally:
        tree.deleteLater()


def test_unselected_prop_lists_every_project_state_name(model) -> None:
    tree = _tree(model, {"heldProp": "player"})
    try:
        root = tree.root_node()
        names = {str(k) for e in model.prop_presets.values() if isinstance(e, dict)
                 for k in (e.get("states") or {})}
        values = {root._hp_state.itemData(i) for i in range(root._hp_state.count())}
        assert values == {"", *names}
    finally:
        tree.deleteLater()


def test_holder_items_cover_player_npcs_and_temp_actors(model) -> None:
    ids = [r[0] for r in model.held_prop_holder_items()]
    assert ids[0] == "player" and len(ids) == len(set(ids))
    assert {n for n, _l in model.all_npc_ids_global()} <= set(ids)
    assert {t for t, _l in model.collect_cutscene_temp_actor_ids()} <= set(ids)


# =========================================================================== #
# 3. 人话摘要
# =========================================================================== #

def test_condition_texts() -> None:
    from tools.dialogue_graph_editor.dialogue_condition_text import condition_expr_text
    from tools.editor.shared.action_structure import summarize_condition
    from tools.narrative_xref.phrases import describe_condition

    leaf = {"heldProp": "player", "prop": "xianteng_torch", "burning": True, "vitalityOp": "<", "vitality": 0.3}
    assert condition_expr_text(leaf) == "玩家手上 xianteng_torch 燃着 火势<0.3"
    assert summarize_condition(leaf) == "玩家手上 xianteng_torch 燃着 火势<0.3"
    assert condition_expr_text({"heldProp": "npc_a", "socket": "left_hand", "propState": "ember", "lock": "lit"}) \
        == "npc_a left_hand 上 状态=ember 锁定不灭"
    assert condition_expr_text({"heldProp": "player"}) == "玩家手上拿着东西"
    assert condition_expr_text({"not": {"heldProp": "player", "burning": True}}) == "非(玩家手上 燃着)"
    assert describe_condition(leaf) == "玩家手上的「xianteng_torch」燃着、火势<0.3"
    assert describe_condition({"heldProp": "player"}) == "玩家手上拿着东西"


# =========================================================================== #
# 4. 校验器
# =========================================================================== #

def _issues(model: ProjectModel, leaf: object) -> list:
    from tools.editor.validator import _walk_conditions

    out: list = []
    _walk_conditions(model, out, [copy.deepcopy(leaf)], "quest", "q", None)
    return out


def _errors(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "error"]


def _warnings(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "warning"]


def test_healthy_leaves_are_clean(model) -> None:
    pid, states = _preset_with_states(model)
    for leaf in (
        {"heldProp": "player"},
        _full(model),
        {"heldProp": "player", "propState": states[0]},
        {"heldProp": "player", "vitalityOp": ">=", "vitality": 1},
        {"not": {"heldProp": "player", "burning": True}},
    ):
        assert [i.message for i in _issues(model, leaf)] == [], leaf


@pytest.mark.parametrize("patch_,sev,frag", [
    ({"heldProp": " "}, "error", "需要非空 heldProp"),
    ({"heldProp": "绝不存在的人"}, "warning", "既不是 player"),
    ({"prop": "绝不存在的挂件"}, "error", "不在 prop_presets.json"),
    ({"propState": "绝不存在的状态"}, "error", "不在挂件预设"),
    ({"lock": "locked"}, "error", "lock 'locked' 非法"),
    ({"lock": True}, "error", "非法"),
    ({"lock": ""}, "warning", "lock 是空串"),
    ({"vitalityOp": "=="}, "error", "vitalityOp '==' 非法"),
    ({"vitality": "0.3"}, "error", "vitality 须为 0..1 的数"),
    ({"vitality": 1.5}, "error", "超出 0..1"),
    ({"vitality": -0.1}, "error", "超出 0..1"),
    ({"burning": "yes"}, "warning", "burning 须为 true/false"),
    ({"socket": 3}, "warning", "socket 须为字符串"),
])
def test_bad_leaves_are_reported(model, patch_, sev, frag) -> None:
    leaf = {**_full(model), **patch_}
    msgs = _errors(_issues(model, leaf)) if sev == "error" else _warnings(_issues(model, leaf))
    assert any(frag in m for m in msgs), msgs


def test_op_and_vitality_must_come_together(model) -> None:
    for leaf in ({"heldProp": "player", "vitalityOp": "<"}, {"heldProp": "player", "vitality": 0.3}):
        assert any("要一起写" in m for m in _errors(_issues(model, leaf))), leaf


def test_state_without_prop_is_a_warning_when_no_preset_has_it(model) -> None:
    issues = _issues(model, {"heldProp": "player", "propState": "绝不存在的状态"})
    assert _errors(issues) == []
    assert any("任何挂件预设的 states 里都不存在" in m for m in _warnings(issues))


def test_prop_without_state_table_rejects_a_state(model) -> None:
    saved = model.prop_presets
    model.prop_presets = {"plain": {"image": "x.png"}}
    try:
        errs = _errors(_issues(model, {"heldProp": "player", "prop": "plain", "propState": "lit"}))
        assert any("没有状态表" in m for m in errs), errs
    finally:
        model.prop_presets = saved


def test_leaf_is_no_longer_an_unrecognized_shape(model) -> None:
    assert not any("无法识别的条件叶子" in m for m in _warnings(_issues(model, {"heldProp": "player"})))


def _iter_held_prop_leaves(node: object):
    if isinstance(node, dict):
        if isinstance(node.get("heldProp"), str):
            yield node
        for v in node.values():
            yield from _iter_held_prop_leaves(v)
    elif isinstance(node, list):
        for v in node:
            yield from _iter_held_prop_leaves(v)


def test_real_data_leaves_are_clean(model) -> None:
    leaves = [leaf for sc in model.scenes.values() for leaf in _iter_held_prop_leaves(sc)]
    if not leaves:
        pytest.skip("现网场景里暂时没有 heldProp 条件")
    for leaf in leaves:
        assert [i.message for i in _issues(model, leaf)] == [], leaf
        assert _roundtrip(model, [leaf]) == [leaf]


# =========================================================================== #
# 5. json_lang
# =========================================================================== #

def test_json_lang_models_the_leaf() -> None:
    from tools.json_lang.extract import extract_language_spec

    spec = extract_language_spec(_ROOT)
    assert "heldProp" in spec.condition_leaves
    assert not any("heldProp" in w for w in spec.warnings), spec.warnings


def test_json_lang_schema_accepts_good_and_rejects_bad(model) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    from tools.json_lang.extract import extract_language_spec
    from tools.json_lang.id_universes import collect_id_universes
    from tools.json_lang.schema_build import build_schema

    pid, states = _preset_with_states(model)
    schema = build_schema(extract_language_spec(_ROOT), collect_id_universes(_ROOT))
    v = jsonschema.Draft7Validator(schema)

    def errs(leaf: dict) -> list:
        return list(v.iter_errors({"zones": [{"conditions": [leaf]}]}))

    assert errs({**FULL, "prop": pid, "propState": states[0]}) == []
    assert errs({"heldProp": "player"}) == []
    assert errs({**FULL, "prop": pid, "propState": states[0], "lock": "locked"})
    assert errs({**FULL, "prop": pid, "propState": "绝不存在的状态"}), "prop 确定时 propState 收窄到它的 states"
    assert errs({**FULL, "prop": pid, "propState": states[0], "vitality": 2})


# =========================================================================== #
# 6. 挂件预设引用
# =========================================================================== #

def test_prop_rename_and_usages_follow_condition_leaves(tmp_path) -> None:
    from tools.editor.shared.prop_preset_refs import rename_prop_references, scan_prop_usages
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    m = ProjectModel()
    m.load_project(root)
    m.scenes["sc_a"]["zones"] = [{"id": "z", "conditions": [
        {"not": {"heldProp": "player", "prop": "torch", "burning": True}},
        {"heldProp": "player", "prop": "lantern"},
    ]}]
    m.prop_presets = {"torch": {"image": "x.png"}, "lantern": {"image": "y.png"}}
    m._dirty.clear()
    assert scan_prop_usages(m, "torch") == ["场景 sc_a"]
    assert rename_prop_references(m, "torch", "fire_torch") == 1
    conds = m.scenes["sc_a"]["zones"][0]["conditions"]
    assert conds[0]["not"]["prop"] == "fire_torch" and conds[1]["prop"] == "lantern"
    assert m._dirty, "改写了引用要标脏"
