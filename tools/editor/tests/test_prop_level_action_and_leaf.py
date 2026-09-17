"""火把养成（玩法清单 A3.7）的**内容接口**：动作 `setPropLevel {prop, level}` 与条件叶
`{propLevel, op?, value}`，以及 `heldProp` 叶新长出来的 `fuelOp`/`fuel`/`effect`。

运行时权威：`src/core/ActionRegistry.ts` + `src/core/actionParamManifest.ts`（动作）、
`src/data/types.ts::PropLevelConditionLeaf` + `src/systems/graphDialogue/evaluateGraphCondition.ts`
（`isPropLevelLeaf` / `PROP_LEVEL_OPS` / `evalPropLevelLeaf` / `heldPropMismatch`）。
覆盖（每条对应一个"漏了会静默"的口子）：

1. 登记面：ACTION_TYPES / _PARAM_SCHEMAS ↔ TS manifest ↔ register 参数名 / 持久化档（save）/
   不进过场白名单 / 选择器宇宙 ↔ json_lang；叶子字段 / 运算符，编辑器 ↔ 校验器 ↔ TS 三处同一份。
2. 候选面 = 校验面：动作与条件叶的挂件下拉**只列配了等级表的**预设，候选里每个都不报、候选外的都报；
   级数上限跟着选中的挂件走，且**越界的当前值不被夹掉**（夹了就是静默改数据）。
3. 往返：动作与叶子打开→不动→导出逐字节（含怪值、悬垂引用、不认识的键、嵌在 not 里）；
   从控件入口改一项只动那一项。
4. 人话摘要：图对话 / 动作大纲 / 信号关系三处。
5. 校验器：好形态干净、每条护栏先改坏一次。
6. json_lang：叶子已建模（无 tripwire）、schema 认好形态、拦坏形态。
7. 挂件预设改名 / 引用扫描跟到动作与条件叶（不跟 = 那条从此恒为假 / 什么都不改，零报错）。
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

from PySide6.QtWidgets import QApplication, QDialog, QLineEdit, QSpinBox  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import condition_expr_tree as cet  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    _PARAM_SCHEMAS,
    _SELECTOR_KIND_UNIVERSE,
    ActionEditor,
    ActionRow,
)
from tools.editor.shared.condition_editor import ConditionEditor  # noqa: E402
from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget  # noqa: E402
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402
from tools.editor.shared.reference_picker import ReferencePickerField  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

ACT = "setPropLevel"

#: 三级的火把（随身那根）、没有等级表的灯笼、以及一块效果
PRESETS = {
    "torch3": {
        "label": "旧纤藤", "image": "/resources/runtime/images/a.png",
        "effects": ["resin"],
        "levels": [
            {"label": "旧纤藤"},
            {"label": "裹布浸桐油", "effects": ["oiled"]},
            {"label": "铁箍加固", "note": "第三级"},
        ],
    },
    "lantern": {"label": "灯笼", "image": "/resources/runtime/images/b.png"},
}
EFFECTS = {
    "oiled": {"label": "裹布浸桐油", "wind": {"windSpeed": 1.25}, "tags": ["耐风"]},
    "resin": {"label": "松脂旺", "burn": 1.4, "tags": ["招东西"]},
}


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(tmp_path_factory, app) -> ProjectModel:
    root = tmp_path_factory.mktemp("proplevel") / "p"
    write_minimal_loadable_project(root)
    dp = root / "public/assets/data"
    for name, doc in (("prop_presets.json", PRESETS), ("prop_effects.json", EFFECTS)):
        (dp / name).write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    m = ProjectModel()
    m.load_project(root)
    return m


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def _manifest_entry(action: str) -> dict[str, set[str]]:
    text = (_ROOT / "src/core/actionParamManifest.ts").read_text("utf-8")
    m = re.search(rf"^\s{{2}}{action}\s*:\s*\{{(?P<body>[^}}]*)\}}", text, re.MULTILINE)
    assert m, f"TS manifest 里没有 {action}"
    out: dict[str, set[str]] = {}
    for key in ("required", "nonEmpty", "optional"):
        km = re.search(rf"{key}\s*:\s*\[(?P<v>[^\]]*)\]", m.group("body"))
        out[key] = set(re.findall(r"'([^']+)'", km.group("v"))) if km else set()
    return out


# =========================================================================== #
# 1. 登记面
# =========================================================================== #

def test_action_registered_on_every_editor_surface() -> None:
    assert ACT in ACTION_TYPES and ACT in CONTENT_ACTION_TYPES, "编辑器类型下拉里选不到"
    man = _manifest_entry(ACT)
    assert man["required"] == {"prop", "level"} and man["nonEmpty"] == {"prop"}
    assert [n for n, _k in _PARAM_SCHEMAS[ACT]] == ["prop", "level"]
    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    i = reg.index(f"executor.register('{ACT}'")
    assert "['prop', 'level']" in reg[i:i + 600], "register 的 paramNames 与编辑器 schema 对不上"
    # 等级进存档（HeldPropSystem.serialize 的 levels 桶）⇒ save，也因此不许进过场白名单
    assert ACTION_PERSISTENCE.get(ACT) == "save"
    allow = json.loads((_ROOT / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert ACT not in allow
    held = (_ROOT / "src/systems/heldProp/HeldPropSystem.ts").read_text("utf-8")
    assert "levels[id] = lv" in held.replace(" ", "") or "levels[id]=lv" in held.replace(" ", ""), \
        "等级不再入档的话，本动作的 save 档与「不进过场白名单」都要重新判断"


def test_selector_universe_matches_json_lang() -> None:
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS

    # 子集宇宙：控件服务的宇宙必须与登记宇宙逐字相同（宇宙级 parity），
    # 标成宽的 prop_presets 就等于声称"任何挂件都收"，而校验器只收有等级表的那些
    assert _SELECTOR_KIND_UNIVERSE.get("prop_preset_leveled") == "prop_leveled"
    assert CONTENT_ID_PARAMS.get((ACT, "prop")) == "prop_leveled"


def _ts_leaf_body() -> str:
    text = (_ROOT / "src/data/types.ts").read_text("utf-8")
    m = re.search(r"export interface PropLevelConditionLeaf \{(?P<body>.*?)\n\}", text, re.S)
    assert m, "types.ts 里没有 PropLevelConditionLeaf"
    return m.group("body")


def test_leaf_fields_match_runtime_type() -> None:
    fields = re.findall(r"^\s*(\w+)\??:", _ts_leaf_body(), re.M)
    assert tuple(fields) == cet._PROP_LEVEL_KEYS, fields


def test_leaf_ops_match_runtime_and_validator() -> None:
    from tools.editor.validator import _PROP_LEVEL_OPS as V_OPS

    ts = set(re.findall(r"'([=!<>]+)'", re.search(r"op\?:\s*([^;]+);", _ts_leaf_body()).group(1)))
    ev = (_ROOT / "src/systems/graphDialogue/evaluateGraphCondition.ts").read_text("utf-8")
    block = re.search(r"const PROP_LEVEL_OPS[^{]*\{(?P<b>.*?)\};", ev, re.S)
    runtime = set(re.findall(r"'([=!<>]+)'\s*:", block.group("b")))
    assert ts == runtime == set(V_OPS) == set(cet._PROP_LEVEL_OPS)
    assert "expr.op ?? '>='" in ev, "缺省运算符变了，编辑器与校验器的 '>=' 缺省要跟"
    assert cet._PROP_LEVEL_DEFAULT_OP == ">="


def test_held_prop_leaf_gained_fuel_and_effect() -> None:
    """`heldProp` 叶的字段顺序 = types.ts 逐字（漏一个 = 那个键被当"不认识的键"透传、编辑不了）。"""
    text = (_ROOT / "src/data/types.ts").read_text("utf-8")
    body = re.search(r"export interface HeldPropConditionLeaf \{(?P<b>.*?)\n\}", text, re.S).group("b")
    assert tuple(re.findall(r"^\s*(\w+)\??:", body, re.M)) == cet._HELD_PROP_KEYS
    assert {"fuelOp", "fuel", "effect"} <= set(cet._HELD_PROP_KEYS)
    # 燃料与火势共用同一张运算符表（运行时 heldPropMismatch 也是同一个 HELD_VITALITY_OPS）
    ops = set(re.findall(r"'([<>=]+)'", re.search(r"fuelOp\?:\s*([^;]+);", body).group(1)))
    assert ops == set(cet._HELD_VITALITY_OPS)


# =========================================================================== #
# 2. 候选面 = 校验面
# =========================================================================== #

def test_leveled_candidates_exclude_presets_without_levels(model: ProjectModel) -> None:
    assert model.prop_level_counts() == {"torch3": 3}
    assert [p for p, _l in model.prop_preset_ids_with_levels()] == ["torch3"]
    assert "lantern" in {p for p, _l in model.all_prop_preset_ids()}, "它仍是合法挂件，只是不能升级"


def _param_issues(model: ProjectModel, act: dict) -> list:
    from tools.editor.validator import _append_action_param_ref_issues

    out: list = []
    _append_action_param_ref_issues(model, out, act, "probe", "p", None)
    return out


def test_action_widgets_follow_the_selector_rule_and_match_the_validator(model: ProjectModel, app) -> None:
    row = ActionRow({"type": ACT, "params": {"prop": "torch3", "level": 2}}, model=model, scene_id=None)
    try:
        w = row._param_widgets["prop"]
        assert type(w) is not QLineEdit and isinstance(w, IdRefSelector)
        assert not w.isEditable(), "引用字段只许选，不许手打"
        assert getattr(w, "_content_id_universe", None) == "prop_leveled"
        assert sorted(i for i in w._ids if i) == ["torch3"], "候选 ≠ 模型候选（只列配了等级表的）"
        lv = row._param_widgets["level"]
        assert isinstance(lv, QSpinBox)
        assert lv.maximum() == 3 and lv.minimum() == 1, "级数上限要跟着选中的挂件走"
        for pid, ok in (("torch3", True), ("lantern", False), ("绝不存在", False), ("", False)):
            issues = _param_issues(model, {"type": ACT, "params": {"prop": pid, "level": 1}})
            assert bool(issues) != ok, (pid, [i.message for i in issues])
            assert all(i.severity == "error" for i in issues)
    finally:
        row.deleteLater()


def test_out_of_range_level_is_not_clamped_by_the_widget(model: ProjectModel, app) -> None:
    """磁盘上写着第 9 级（预设后来被砍成 3 级）时，spin 不许把它夹成 3——那是静默改数据，
    连校验器本该报的那条 error 都跟着消失。"""
    act = {"type": ACT, "params": {"prop": "torch3", "level": 9}}
    row = ActionRow(copy.deepcopy(act), model=model, scene_id=None)
    try:
        assert row._param_widgets["level"].value() == 9
        assert row.to_dict()["params"]["level"] == 9
    finally:
        row.deleteLater()
    assert any("超出挂件" in i.message for i in _param_issues(model, act))


# =========================================================================== #
# 3. 往返
# =========================================================================== #

def _roundtrip_action(model: ProjectModel, act: dict) -> dict:
    ed = ActionEditor("t")
    ed.set_project_context(model, None)
    ed.set_data([copy.deepcopy(act)])
    try:
        out = ed.to_list()
        assert len(out) == 1
        return out[0]
    finally:
        ed.deleteLater()


@pytest.mark.parametrize("act", [
    {"type": ACT, "params": {"prop": "torch3", "level": 1}},
    {"type": ACT, "params": {"prop": "torch3", "level": 3}},
    # 悬垂 / 没有等级表的挂件：原样保留（改名、砍掉 levels 之后校验器说话，编辑器不替它修）
    {"type": ACT, "params": {"prop": "lantern", "level": 2}},
    {"type": ACT, "params": {"prop": "绝不存在", "level": 2}},
    # 不认识的键透传
    {"type": ACT, "params": {"prop": "torch3", "level": 2, "extra": 1}},
])
def test_action_roundtrips_byte_for_byte(model: ProjectModel, act, app) -> None:
    assert _dumps(_roundtrip_action(model, act)) == _dumps(act)


def test_action_widget_writes_what_was_picked(model: ProjectModel, app) -> None:
    ed = ActionEditor("t")
    ed.set_project_context(model, None)
    ed.set_data([{"type": ACT, "params": {"prop": "lantern", "level": 1}}])
    try:
        row = ed._rows[0]
        w = row._param_widgets["prop"]
        w.set_current("torch3")
        w.value_changed.emit("torch3")
        assert row._param_widgets["level"].maximum() == 3, "换挂件要刷新级数上限"
        row._param_widgets["level"].setValue(3)
        assert ed.to_list()[0] == {"type": ACT, "params": {"prop": "torch3", "level": 3}}
    finally:
        ed.deleteLater()


def _roundtrip_leaf(model: ProjectModel, conditions: list[dict]) -> list[dict]:
    ed = ConditionEditor()
    ed.set_flag_pattern_context(model, None)
    ed.set_data(copy.deepcopy(conditions))
    try:
        return ed.to_list()
    finally:
        ed.deleteLater()


@pytest.mark.parametrize("leaf", [
    {"propLevel": "torch3", "op": ">=", "value": 2},
    {"propLevel": "torch3", "value": 2},                       # op 不写 = >=
    {"propLevel": "torch3", "op": "==", "value": 1},
    # 运行时不认的怪值 / 悬垂引用 / 不认识的键：没动过就原样留着
    {"备注": [1], "propLevel": " torch3 ", "op": "~=", "value": "2"},
    {"propLevel": "绝不存在的挂件", "op": "<", "value": 99},
    {"propLevel": "lantern", "value": 2},                      # 没有等级表：校验器 warning，编辑器不改
    # heldProp 的新三项
    {"heldProp": "player", "fuelOp": "<", "fuel": 0.2},
    {"heldProp": "player", "effect": "耐风"},
    {"heldProp": "player", "vitalityOp": "<", "vitality": 0.3, "fuelOp": "<=", "fuel": 0.33333333,
     "effect": "oiled", "lock": "lit"},
    {"heldProp": "player", "fuelOp": "=="},                    # 落单的一半：校验器报，编辑器保值
    {"heldProp": "player", "fuel": 2},
    {"heldProp": "player", "effect": ""},
])
def test_leaf_roundtrips_byte_for_byte(model: ProjectModel, leaf, app) -> None:
    for conds in ([leaf], [{"not": leaf}], [{"any": [{"flag": "f"}, leaf]}]):
        out = _roundtrip_leaf(model, conds)
        assert json.dumps(out, ensure_ascii=False) == json.dumps(conds, ensure_ascii=False)


def _tree(model: ProjectModel, expr: dict | None) -> ConditionExprTreeRootWidget:
    tree = ConditionExprTreeRootWidget(model_getter=lambda: model)
    tree.set_expr(expr)
    return tree


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


def test_new_prop_level_leaf_writes_only_what_was_set(model: ProjectModel, app) -> None:
    tree = _tree(model, None)
    try:
        root = tree.root_node()
        got: list[int] = []
        tree.changed.connect(lambda: got.append(1))
        root._kind.setCurrentIndex(root._kind.findData("propLevel"))
        assert tree.get_expr() is None, "没选挂件就不是一条条件"

        rows = _choose(root._lv_prop, "torch3")
        assert [r[0] for r in rows] == ["torch3"], "候选 = 校验面（只列配了等级表的）"
        assert tree.get_expr() == {"propLevel": "torch3", "value": 1}, "op 没动就不写（运行时缺省 >=）"
        assert got, "用户选挂件要外发 changed"
        assert root._lv_value.maximum() == 3, "级数上限跟着挂件走"
        root._lv_value.setValue(2)
        root._lv_op.setCurrentIndex(root._lv_op.findData("=="))
        assert tree.get_expr() == {"propLevel": "torch3", "op": "==", "value": 2}
        root._lv_op.setCurrentIndex(root._lv_op.findData(""))
        assert tree.get_expr() == {"propLevel": "torch3", "value": 2}, "选回「不写」= 删掉 op 键"
    finally:
        tree.deleteLater()


def test_editing_one_prop_level_field_keeps_the_others_raw(model: ProjectModel, app) -> None:
    raw = {"备注": "留着", "propLevel": "torch3", "op": "~=", "value": 2}
    tree = _tree(model, raw)
    try:
        root = tree.root_node()
        assert root._lv_op.currentData() == cet._HP_RAW and "~=" in root._lv_op.currentText(), \
            "怪运算符保值展示，不顶替成第一项"
        root._lv_value.setValue(3)
        assert tree.get_expr() == {**raw, "value": 3}
    finally:
        tree.deleteLater()


def test_held_prop_fuel_and_effect_widgets(model: ProjectModel, app) -> None:
    from tools.editor.shared.action_editor import FilterableTypeCombo

    tree = _tree(model, {"heldProp": "player"})
    try:
        root = tree.root_node()
        assert isinstance(root._hp_effect, ReferencePickerField), "引用字段禁裸 QLineEdit"
        assert not root._hp_fuel.isEnabled(), "没选运算符，燃料阈值不可编辑"
        root._hp_fuel_op.setCurrentIndex(root._hp_fuel_op.findData("<"))
        assert root._hp_fuel.isEnabled()
        root._hp_fuel.setValue(0.2)
        rows = _choose(root._hp_effect, "耐风")
        assert {r[0] for r in rows} == {v for v, _l, _d in model.prop_effect_match_items()}
        assert {"oiled", "resin", "耐风", "招东西"} <= {r[0] for r in rows}, "候选 = 效果块 id ∪ 标签"
        assert tree.get_expr() == {"heldProp": "player", "fuelOp": "<", "fuel": 0.2, "effect": "耐风"}
        root._hp_fuel_op.setCurrentIndex(root._hp_fuel_op.findData(""))
        assert tree.get_expr() == {"heldProp": "player", "effect": "耐风"}, "不限 = 整对都删"
        assert isinstance(root._hp_socket, FilterableTypeCombo)
    finally:
        tree.deleteLater()


def test_programmatic_load_and_refresh_do_not_emit(model: ProjectModel, app) -> None:
    tree = _tree(model, None)
    try:
        got: list[int] = []
        tree.changed.connect(lambda: got.append(1))
        leaf = {"propLevel": "torch3", "op": ">=", "value": 2}
        tree.set_expr(leaf)
        tree.set_model_refresh()
        assert got == [] and tree.get_expr() == leaf
    finally:
        tree.deleteLater()


# =========================================================================== #
# 4. 人话摘要
# =========================================================================== #

def test_condition_texts() -> None:
    from tools.dialogue_graph_editor.dialogue_condition_text import condition_expr_text
    from tools.editor.shared.action_structure import summarize_condition
    from tools.narrative_xref.phrases import describe_condition

    leaf = {"propLevel": "xianteng_torch", "op": ">=", "value": 2}
    assert condition_expr_text(leaf) == "挂件 xianteng_torch 等级 >= 2"
    assert summarize_condition(leaf) == "挂件 xianteng_torch 等级 >= 2"
    assert condition_expr_text({"propLevel": "t", "value": 3}) == "挂件 t 等级 >= 3", "op 不写显示缺省"
    assert describe_condition(leaf) == "「xianteng_torch」升到第 2 级或更高"
    assert describe_condition({"propLevel": "t", "op": "==", "value": 1}) == "「t」正是第 1 级"
    held = {"heldProp": "player", "fuelOp": "<", "fuel": 0.2, "effect": "驱虫"}
    assert condition_expr_text(held) == "玩家手上 燃料<0.2 带驱虫"
    assert summarize_condition(held) == "玩家手上 燃料<0.2 带驱虫"
    assert describe_condition(held) == "玩家手上拿的东西燃料<0.2、带「驱虫」"


def test_switch_verdict_sees_the_new_leaf() -> None:
    """认不出来的叶子运行时**恒假**——分支检查器必须把它算成正常条件，不然满屏「这条永不命中」。"""
    from tools.dialogue_graph_editor.dialogue_condition_text import NORMAL, case_verdict

    assert case_verdict({"conditions": [{"propLevel": "t", "op": ">=", "value": 2}], "next": "a"}) == NORMAL


# =========================================================================== #
# 5. 校验器
# =========================================================================== #

def _cond_issues(model: ProjectModel, leaf: object) -> list:
    from tools.editor.validator import _walk_conditions

    out: list = []
    _walk_conditions(model, out, [copy.deepcopy(leaf)], "quest", "q", None)
    return out


def _errors(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "error"]


def _warnings(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "warning"]


def test_healthy_prop_level_leaves_are_clean(model: ProjectModel) -> None:
    for leaf in (
        {"propLevel": "torch3", "op": ">=", "value": 2},
        {"propLevel": "torch3", "value": 1},
        {"propLevel": "torch3", "op": "!=", "value": 9},   # != 越界不报（"不是第 9 级"是合理写法）
        {"not": {"propLevel": "torch3", "op": "<", "value": 3}},
    ):
        assert [i.message for i in _cond_issues(model, leaf)] == [], leaf


@pytest.mark.parametrize("leaf,sev,frag", [
    ({"propLevel": " ", "value": 1}, "error", "需要非空挂件预设 id"),
    ({"propLevel": "绝不存在", "value": 1}, "error", "不在 prop_presets.json"),
    ({"propLevel": "lantern", "value": 2}, "warning", "没有等级表"),
    ({"propLevel": "torch3", "op": "~", "value": 1}, "error", "op '~' 非法"),
    ({"propLevel": "torch3", "op": True, "value": 1}, "error", "非法"),
    ({"propLevel": "torch3"}, "error", "value 须为数"),
    ({"propLevel": "torch3", "value": "2"}, "error", "value 须为数"),
    ({"propLevel": "torch3", "value": True}, "error", "value 须为数"),
    ({"propLevel": "torch3", "op": ">=", "value": 9}, "warning", "只有 1..3 级"),
    ({"propLevel": "torch3", "op": ">=", "value": 0}, "warning", "只有 1..3 级"),
])
def test_bad_prop_level_leaves_are_reported(model: ProjectModel, leaf, sev, frag) -> None:
    msgs = _errors(_cond_issues(model, leaf)) if sev == "error" else _warnings(_cond_issues(model, leaf))
    assert any(frag in m for m in msgs), msgs


def test_prop_level_leaf_is_no_longer_an_unrecognized_shape(model: ProjectModel) -> None:
    issues = _cond_issues(model, {"propLevel": "torch3", "op": ">=", "value": 2})
    assert not any("无法识别的条件叶子" in m for m in _warnings(issues))


@pytest.mark.parametrize("patch_,sev,frag", [
    ({"fuelOp": "=="}, "error", "fuelOp '==' 非法"),
    ({"fuelOp": "<"}, "error", "要一起写"),
    ({"fuel": 0.2}, "error", "要一起写"),
    ({"fuelOp": "<", "fuel": "0.2"}, "error", "fuel 须为 0..1 的数"),
    ({"fuelOp": "<", "fuel": 1.5}, "error", "超出 0..1"),
    ({"effect": "绝不存在的脾气"}, "warning", "既不是 prop_effects.json"),
    ({"effect": ""}, "warning", "effect 是空串"),
    ({"effect": 3}, "warning", "effect 须为字符串"),
])
def test_held_prop_new_fields_are_validated(model: ProjectModel, patch_, sev, frag) -> None:
    leaf = {"heldProp": "player", **patch_}
    msgs = _errors(_cond_issues(model, leaf)) if sev == "error" else _warnings(_cond_issues(model, leaf))
    assert any(frag in m for m in msgs), msgs


def test_healthy_held_prop_new_fields_are_clean(model: ProjectModel) -> None:
    for leaf in (
        {"heldProp": "player", "fuelOp": "<", "fuel": 0.2},
        {"heldProp": "player", "effect": "oiled"},
        {"heldProp": "player", "effect": "耐风"},         # 标签也命中
    ):
        assert [i.message for i in _cond_issues(model, leaf)] == [], leaf


@pytest.mark.parametrize("params,frag", [
    ({"level": 2}, "缺 prop"),
    ({"prop": "绝不存在", "level": 2}, "不在 prop_presets.json"),
    ({"prop": "lantern", "level": 2}, "没有等级表"),
    ({"prop": "torch3"}, "level 须为整数级数"),
    ({"prop": "torch3", "level": "2"}, "level 须为整数级数"),
    ({"prop": "torch3", "level": True}, "level 须为整数级数"),
    ({"prop": "torch3", "level": 2.5}, "不是整数"),
    ({"prop": "torch3", "level": 0}, "超出挂件"),
    ({"prop": "torch3", "level": 4}, "超出挂件"),
])
def test_bad_set_prop_level_is_reported(model: ProjectModel, params, frag) -> None:
    msgs = _errors(_param_issues(model, {"type": ACT, "params": params}))
    assert any(frag in m for m in msgs), msgs


def test_healthy_set_prop_level_is_clean(model: ProjectModel) -> None:
    for level in (1, 2, 3):
        act = {"type": ACT, "params": {"prop": "torch3", "level": level}}
        assert [i.message for i in _param_issues(model, act)] == [], act


def test_repo_data_has_no_new_issues() -> None:
    """现网那两条 `setPropLevel` 与四条 `propLevel` 本来就该是干净的（它们是本次的验收样本）。"""
    m = ProjectModel()
    m.load_project(_ROOT)
    from tools.editor.validator import validate

    bad = [i for i in validate(m)
           if ("setPropLevel" in i.message or "propLevel" in i.message)]
    assert bad == [], [i.message for i in bad]


# =========================================================================== #
# 6. json_lang
# =========================================================================== #

def test_json_lang_models_the_leaf() -> None:
    from tools.json_lang.extract import extract_language_spec

    spec = extract_language_spec(_ROOT)
    assert "propLevel" in spec.condition_leaves
    assert not any("propLevel" in w for w in spec.warnings), spec.warnings


def test_json_lang_schema_accepts_good_and_rejects_bad(tmp_path) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    from tools.json_lang.extract import extract_language_spec
    from tools.json_lang.id_universes import collect_id_universes
    from tools.json_lang.schema_build import build_schema

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    dp = root / "public/assets/data"
    for name, doc in (("prop_presets.json", PRESETS), ("prop_effects.json", EFFECTS)):
        (dp / name).write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    ud = collect_id_universes(root)
    assert ud.ids["prop_leveled"] == ["torch3"], "只有配了等级表的进这个宇宙"
    assert set(ud.ids["prop_effect_matches"]) == {"oiled", "resin", "耐风", "招东西"}
    schema = build_schema(extract_language_spec(_ROOT), ud)
    v = jsonschema.Draft7Validator(schema)

    def cond_errs(leaf: dict) -> list:
        return list(v.iter_errors({"zones": [{"conditions": [leaf]}]}))

    def act_errs(params: dict) -> list:
        return list(v.iter_errors({"actions": [{"type": ACT, "params": params}]}))

    assert cond_errs({"propLevel": "torch3", "op": ">=", "value": 2}) == []
    assert cond_errs({"propLevel": "torch3", "value": 1}) == []
    assert cond_errs({"propLevel": "lantern", "value": 1}), "没有等级表的不在宇宙里"
    assert cond_errs({"propLevel": "torch3", "op": "~", "value": 1})
    assert cond_errs({"propLevel": "torch3", "value": 0})
    assert cond_errs({"heldProp": "player", "fuelOp": "<", "fuel": 0.2, "effect": "耐风"}) == []
    assert cond_errs({"heldProp": "player", "effect": "绝不存在的脾气"})
    assert cond_errs({"heldProp": "player", "fuelOp": "~", "fuel": 0.2})
    assert act_errs({"prop": "torch3", "level": 2}) == []
    assert act_errs({"prop": "lantern", "level": 2})


# =========================================================================== #
# 7. 挂件预设改名 / 引用扫描
# =========================================================================== #

def test_prop_rename_and_usages_follow_the_action_and_the_leaf(tmp_path) -> None:
    from tools.editor.shared.prop_preset_refs import rename_prop_references, scan_prop_usages

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    m = ProjectModel()
    m.load_project(root)
    m.scenes["sc_a"]["zones"] = [{"id": "z", "conditions": [
        {"propLevel": "torch3", "op": ">=", "value": 2},
        {"not": {"heldProp": "player", "prop": "torch3"}},
        {"propLevel": "lantern", "value": 1},
    ]}]
    m.scenes["sc_a"]["hotspots"] = [{"id": "h", "actions": [
        {"type": ACT, "params": {"prop": "torch3", "level": 3}},
    ]}]
    m.prop_presets = copy.deepcopy(PRESETS)
    m.prop_presets["torch3"] = PRESETS["torch3"]
    m._dirty.clear()
    assert scan_prop_usages(m, "torch3") == ["场景 sc_a"]
    assert rename_prop_references(m, "torch3", "fire_torch") == 3
    conds = m.scenes["sc_a"]["zones"][0]["conditions"]
    assert conds[0]["propLevel"] == "fire_torch"
    assert conds[1]["not"]["prop"] == "fire_torch"
    assert conds[2]["propLevel"] == "lantern"
    assert m.scenes["sc_a"]["hotspots"][0]["actions"][0]["params"]["prop"] == "fire_torch"
    assert m._dirty, "改写了引用要标脏"
