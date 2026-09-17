"""火种（`ItemDef.igniter`，玩法清单 A3.7）与 `setActiveIgniter` 在编辑器 / 校验器 / json_lang 各面的契约。

运行时已落地：`src/data/types.ts` 的 `ItemIgniterDef {uses?, seconds, windLimit}`；`InventoryManager` 给写了 `igniter`
又没写 `use` 的物品合成「设为火种」按钮（动作 `setActiveIgniter {item}`）；`HeldPropSystem` 按 T 用当前火种点火，
结果文案在 strings.json 的 `igniter` 类。本文件钉（每条对应一个"漏了会静默"的口子）：

1. 登记面：ACTION_TYPES / _PARAM_SCHEMAS ↔ TS manifest ↔ register 参数名 / 持久化档（save）/ 不进过场白名单 /
   选择器宇宙 ↔ json_lang CONTENT_ID_PARAMS；TS 的火种键 ↔ 表单键 ↔ 校验器键；运行时结果名 ↔ strings 键。
2. 候选面 = 校验面：动作表单的物品下拉只列火种，候选里每个都不报、候选外的都报（同一个 ProjectModel 函数）。
3. 动作往返：最小形态逐字节、悬垂保值、不认识的键透传、从控件入口改值。
4. 校验器：火种块形状（seconds / windLimit > 0、uses ≥ 1 整数、非对象、不认识的键）、火种又写 use、动作参数。
5. 物品页「火种」块：打开→不动→Apply 逐字节（含坏值 / int·float 表示 / 不认识的键 / 非对象）、不判脏、勾上写起步值、
   改值判脏且切走提交、勾掉删键、切到别的物品清表单、use 区提示。
6. json_lang：igniter_items 宇宙、schema 里 setActiveIgniter.item 枚举只收火种。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    _PARAM_SCHEMAS,
    _SELECTOR_KIND_UNIVERSE,
    ActionEditor,
    ActionRow,
)
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

ACT = "setActiveIgniter"

HUORONG = {
    "id": "huorong", "name": "火镰火绒", "type": "consumable", "description": "慢。",
    "buyPrice": 2, "maxStack": 20, "tags": ["引火"],
    "igniter": {"uses": 1, "seconds": 2.5, "windLimit": 3},
}
HUOZHEZI = {
    "id": "huozhezi", "name": "火折子", "type": "consumable", "description": "三回。",
    "maxStack": 10, "igniter": {"uses": 3, "seconds": 1, "windLimit": 6.0},
}
# 最小形态：不写 uses（缺省 1）
YANGHUO = {
    "id": "yanghuo", "name": "洋火", "type": "consumable", "description": "", "maxStack": 20,
    "igniter": {"seconds": 0.4, "windLimit": 10},
}
PLAIN = {"id": "plain_rope", "name": "麻绳", "type": "consumable", "description": "", "maxStack": 1}
# 坏形态：运行时当火种（真值）却读不出参数——不算候选
BOGUS = {"id": "bogus", "name": "怪", "type": "consumable", "description": "", "maxStack": 1, "igniter": True}


def _items() -> list[dict]:
    return copy.deepcopy([HUORONG, HUOZHEZI, YANGHUO, PLAIN, BOGUS])


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _model_at(root: Path, items: list[dict]) -> ProjectModel:
    write_minimal_loadable_project(root)
    (root / "public/assets/data/items.json").write_bytes(
        (json.dumps(items, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    m = ProjectModel()
    m.load_project(root)
    return m


@pytest.fixture(scope="module")
def model(tmp_path_factory, app) -> ProjectModel:
    return _model_at(tmp_path_factory.mktemp("igniter") / "p", _items())


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
    assert man["required"] == {"item"} and man["nonEmpty"] == {"item"} and man["optional"] == set()
    assert [n for n, _k in _PARAM_SCHEMAS[ACT]] == ["item"]
    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    i = reg.index(f"executor.register('{ACT}'")
    assert "['item']" in reg[i:i + 600], "register 的 paramNames 与编辑器 schema 对不上"
    # 当前火种跟背包一起入档 ⇒ save；也因此不许进过场白名单（过场内禁改存档）
    assert ACTION_PERSISTENCE.get(ACT) == "save"
    allow = json.loads((_ROOT / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert ACT not in allow


def test_selector_universe_matches_json_lang() -> None:
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS

    assert _SELECTOR_KIND_UNIVERSE.get("igniter_item") == "igniter_items"
    assert CONTENT_ID_PARAMS.get((ACT, "item")) == "igniter_items"


def test_inventory_synthesizes_the_same_action_shape() -> None:
    """背包里「设为火种」按钮跑的就是这条动作、这个参数名——编辑器配出来的与运行时合成的同形。"""
    src = (_ROOT / "src/systems/InventoryManager.ts").read_text("utf-8")
    assert "{ type: 'setActiveIgniter', params: { item: def.id } }" in src
    assert "if (def && !def.use && def.igniter) return this.resolveIgniterUse(def);" in src, \
        "「写了 use 就按 use 走」的判据变了，校验器 igniter+use 的 warning 要跟"


def test_igniter_keys_match_types_ts() -> None:
    from tools.editor.editors.item_editor import _IGNITER_KEYS
    from tools.editor.validator import _ITEM_IGNITER_KEYS

    ts = (_ROOT / "src/data/types.ts").read_text("utf-8")
    m = re.search(r"export interface ItemIgniterDef \{(?P<body>.*?)\n\}", ts, re.DOTALL)
    assert m, "types.ts 里找不到 ItemIgniterDef"
    ts_keys = set(re.findall(r"^\s{2}(\w+)\??\s*:", m.group("body"), re.MULTILINE))
    assert ts_keys == set(_IGNITER_KEYS) == set(_ITEM_IGNITER_KEYS) == {"uses", "seconds", "windLimit"}
    assert re.search(r"^\s{2}seconds: number;", m.group("body"), re.MULTILINE), "seconds 应必填"
    assert re.search(r"^\s{2}windLimit: number;", m.group("body"), re.MULTILINE), "windLimit 应必填"
    assert re.search(r"^\s{2}uses\?: number;", m.group("body"), re.MULTILINE), "uses 应可选"


def test_strings_cover_every_ignite_result_shown_to_the_player() -> None:
    """运行时 `strings.get('igniter', result)`：结果名缺一个键，玩家就只看不到那一行字（`text !== result` 挡掉）。"""
    held = (_ROOT / "src/systems/heldProp/HeldPropSystem.ts").read_text("utf-8")
    m = re.search(r"export type HeldIgniteResult\s*=(?P<body>[^;]*);", held)
    assert m, "HeldPropSystem.ts 里找不到 HeldIgniteResult"
    results = set(re.findall(r"'(\w+)'", m.group("body")))
    silent = {"started", "success", "failInterrupted"}  # Game.onPlayerIgniteResult 不出字的三个
    strings = json.loads((_ROOT / "public/assets/data/strings.json").read_text("utf-8"))
    assert set(strings["igniter"]) == results - silent
    inv_keys = {"setIgniter", "igniterCurrent", "igniterCurrentTag", "igniterOpenedLeft"}
    assert inv_keys <= set(strings["inventory"])
    assert "{n}" in strings["inventory"]["igniterOpenedLeft"]


# =========================================================================== #
# 2. 候选面 = 校验面
# =========================================================================== #

def test_candidates_are_object_igniters_only(model: ProjectModel) -> None:
    assert model.igniter_item_ids() == [("huorong", "火镰火绒"), ("huozhezi", "火折子"), ("yanghuo", "洋火")]


def _param_issues(model: ProjectModel, act: dict, scene: str | None = None) -> list:
    from tools.editor.validator import _append_action_param_ref_issues

    out: list = []
    _append_action_param_ref_issues(model, out, act, "probe", "p", scene)
    return out


@pytest.mark.parametrize("scene", [None, "sc_a"])
def test_widget_follows_selector_rule_and_candidates_equal_validator(model: ProjectModel, app, scene) -> None:
    row = ActionRow({"type": ACT, "params": {"item": "huorong"}}, model=model, scene_id=scene)
    try:
        w = row._param_widgets["item"]
        assert type(w) is not QLineEdit and isinstance(w, IdRefSelector)
        assert not w.isEditable(), "引用字段只许选，不许手打"
        assert getattr(w, "_content_id_universe", None) == "igniter_items"
        cands = [i for i, _l in model.igniter_item_ids()]
        assert sorted(i for i in w._ids if i) == sorted(cands), "下拉候选 ≠ 模型候选"
        for iid in cands + ["plain_rope", "bogus", "绝不存在", ""]:
            issues = _param_issues(model, {"type": ACT, "params": {"item": iid}}, scene)
            assert bool(issues) == (iid not in cands), (iid, [i.message for i in issues])
            assert all(i.severity == "error" for i in issues)
    finally:
        row.deleteLater()


# =========================================================================== #
# 3. 动作往返
# =========================================================================== #

def _roundtrip(model: ProjectModel, act: dict, scene_id: str | None = None) -> dict:
    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([copy.deepcopy(act)])
    try:
        out = ed.to_list()
        assert len(out) == 1
        return out[0]
    finally:
        ed.deleteLater()


@pytest.mark.parametrize("scene", [None, "sc_a"])
def test_minimal_form_and_dangling_values_roundtrip_byte_for_byte(model: ProjectModel, scene) -> None:
    for act in (
        {"type": ACT, "params": {"item": "huozhezi"}},
        # 悬垂值原样保留（物品改名 / 删了 igniter 块）
        {"type": ACT, "params": {"item": "plain_rope"}},
        {"type": ACT, "params": {"item": "绝不存在"}},
        # 不认识的键透传
        {"type": ACT, "params": {"item": "yanghuo", "extra": 1}},
    ):
        assert _dumps(_roundtrip(model, act, scene)) == _dumps(act), act


def test_widget_writes_the_picked_item(model: ProjectModel, app) -> None:
    ed = ActionEditor("t")
    ed.set_project_context(model, None)
    ed.set_data([{"type": ACT, "params": {"item": "huorong"}}])
    try:
        w = ed._rows[0]._param_widgets["item"]
        w.set_current("yanghuo")
        w.value_changed.emit("yanghuo")
        assert ed.to_list()[0] == {"type": ACT, "params": {"item": "yanghuo"}}
    finally:
        ed.deleteLater()


def test_dangling_value_is_shown_not_dropped(model: ProjectModel, app) -> None:
    row = ActionRow({"type": ACT, "params": {"item": "plain_rope"}}, model=model, scene_id=None)
    try:
        w = row._param_widgets["item"]
        assert "plain_rope" in w._ids, "悬垂值要作为孤儿行保值展示"
        assert w.current_id() == "plain_rope"
    finally:
        row.deleteLater()


# =========================================================================== #
# 4. 校验器
# =========================================================================== #

def _errors(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "error"]


def _warnings(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "warning"]


def _item_issues(item: dict) -> list:
    from tools.editor.validator import _validate_item_igniter

    out: list = []
    _validate_item_igniter(item, str(item.get("id")), out)
    return out


def test_action_bad_forms_are_errors(model: ProjectModel) -> None:
    for params, frag in (
        ({}, "setActiveIgniter 缺 item"),
        ({"item": "  "}, "setActiveIgniter 缺 item"),
        ({"item": 3}, "setActiveIgniter 缺 item"),
        ({"item": "plain_rope"}, "不是火种"),
        ({"item": "bogus"}, "不是火种"),
        ({"item": "绝不存在"}, "不存在的物品"),
    ):
        errs = _errors(_param_issues(model, {"type": ACT, "params": params}))
        assert any(frag in m for m in errs), (params, errs)
    assert _param_issues(model, {"type": ACT, "params": {"item": " huorong "}}) == [], "运行时 trim 后查"


def test_action_is_checked_wherever_actions_are_walked(model: ProjectModel) -> None:
    """走共享动作链：嵌在 runActionsIf 里、放在物品 use.actions 里都查。"""
    from tools.editor.validator import _validate_item_use, _walk_action_defs

    nested = [{"type": "runActionsIf", "params": {
        "condition": {"flag": "x"}, "actions": [{"type": ACT, "params": {"item": "plain_rope"}}]}}]
    out: list = []
    _walk_action_defs(model, out, nested, "quest", "q", None)
    assert any("不是火种" in m for m in _errors(out)), [i.message for i in out]
    item = {**copy.deepcopy(PLAIN), "use": {"label": "设", "actions": [{"type": ACT, "params": {}}]}}
    out = []
    _validate_item_use(model, item, "plain_rope", out)
    assert any("setActiveIgniter 缺 item" in m for m in _errors(out))


@pytest.mark.parametrize("item", [HUORONG, HUOZHEZI, YANGHUO,
                                  {**PLAIN, "igniter": {"uses": 3.0, "seconds": 1, "windLimit": 0.5}}])
def test_healthy_igniters_are_clean(item: dict) -> None:
    assert [i.message for i in _item_issues(copy.deepcopy(item))] == []


def test_plain_item_is_silent() -> None:
    assert _item_issues(copy.deepcopy(PLAIN)) == []


@pytest.mark.parametrize("key", ["seconds", "windLimit"])
@pytest.mark.parametrize("bad", [..., 0, -1, None, "2", True, float("nan"), float("inf"), {}])
def test_seconds_and_wind_limit_must_be_positive_numbers(key: str, bad: object) -> None:
    ig = {"seconds": 1, "windLimit": 5}
    if bad is ...:
        ig.pop(key)
    else:
        ig[key] = bad
    errs = _errors(_item_issues({**PLAIN, "igniter": ig}))
    assert any(f"igniter.{key}" in m for m in errs), errs


@pytest.mark.parametrize("bad", [0, -2, 2.5, "3", True, None, float("nan")])
def test_uses_must_be_an_integer_at_least_one(bad: object) -> None:
    errs = _errors(_item_issues({**PLAIN, "igniter": {"uses": bad, "seconds": 1, "windLimit": 5}}))
    assert any("igniter.uses" in m for m in errs), errs


def test_non_object_igniter() -> None:
    for truthy in (True, 1, "yes", [1]):
        errs = _errors(_item_issues({**PLAIN, "igniter": truthy}))
        assert any("igniter 须为对象" in m for m in errs), (truthy, errs)
    for falsy in (None, False, 0, ""):
        issues = _item_issues({**PLAIN, "igniter": falsy})
        assert _errors(issues) == [] and any("当不是火种" in m for m in _warnings(issues)), falsy


def test_unknown_keys_warn() -> None:
    issues = _item_issues({**PLAIN, "igniter": {"seconds": 1, "windLimit": 5, "windlimit": 6}})
    assert _errors(issues) == []
    assert any("不认识的键" in m and "windlimit" in m for m in _warnings(issues))


def test_igniter_with_use_warns_that_set_igniter_is_not_offered() -> None:
    item = {**copy.deepcopy(HUORONG), "use": {"label": "点", "resultText": "嗯"}}
    w = _warnings(_item_issues(item))
    assert any("设为火种" in m and "use" in m for m in w), w
    assert not any("设为火种" in m for m in _warnings(_item_issues({**copy.deepcopy(HUORONG), "use": None})))


def test_validate_items_runs_the_igniter_block(model: ProjectModel) -> None:
    from tools.editor.validator import _validate_items

    out: list = []
    _validate_items(model, out)
    msgs = [(i.item_id, i.severity) for i in out if "igniter" in i.message]
    assert msgs == [("bogus", "error")], [i.message for i in out]


def test_real_project_igniter_data_is_clean(app) -> None:
    from tools.editor.validator import _validate_items

    m = ProjectModel()
    m.load_project(_ROOT)
    assert m.igniter_item_ids(), "真实工程里应有火种物品"
    out: list = []
    _validate_items(m, out)
    assert [i.message for i in out if "igniter" in i.message or "火种" in i.message] == []
    for iid, _l in m.igniter_item_ids():
        assert _param_issues(m, {"type": ACT, "params": {"item": iid}}) == []


# =========================================================================== #
# 5. 物品页「火种」块
# =========================================================================== #

@pytest.fixture()
def editor(tmp_path: Path, app):
    from tools.editor.editors.item_editor import ItemEditor

    def make(items: list[dict]):
        m = _model_at(tmp_path / "p", copy.deepcopy(items))
        ed = ItemEditor(m)
        ed._refresh()
        return ed, m

    return make


def _row_of(m: ProjectModel, iid: str) -> int:
    return [str(it.get("id")) for it in m.items].index(iid)


@pytest.mark.parametrize("item", [
    HUORONG, HUOZHEZI, YANGHUO, PLAIN, BOGUS,
    {**PLAIN, "id": "i_null", "igniter": None},
    # 坏值 / 越界 / 缺必填 / 不认识的键：不动就一个字节不改
    {**PLAIN, "id": "i_bad", "igniter": {"windLimit": "大", "uses": 2.5, "note": "x", "seconds": -1}},
    {**PLAIN, "id": "i_huge", "igniter": {"uses": 1e30, "seconds": 9999, "windLimit": 0.001}},
    {**PLAIN, "id": "i_empty", "igniter": {}},
])
def test_open_then_apply_changes_nothing_and_is_not_dirty(editor, item: dict) -> None:
    ed, m = editor([item])
    before = _dumps(m.items)
    ed._list.setCurrentRow(0)
    assert not ed._is_dirty(), "纯选择不判脏"
    ed._apply()
    assert _dumps(m.items) == before
    assert not ed._is_dirty()


def test_form_loads_values(editor) -> None:
    ed, m = editor(_items())
    ed._list.setCurrentRow(_row_of(m, "huozhezi"))
    assert ed._ig_enabled.isChecked() and ed._ig_body.isEnabled()
    assert (ed._ig_uses.value(), ed._ig_seconds.value(), ed._ig_wind.value()) == (3, 1.0, 6.0)
    assert ed._ig_wind.suffix().strip() == "m/s"
    for w, needle in ((ed._ig_uses, "一份能点几次"), (ed._ig_seconds, "点着要多久"), (ed._ig_wind, "m/s")):
        assert needle in w.toolTip()
    # 切到没有火种的物品：表单清回不勾，Apply 不长键
    ed._list.setCurrentRow(_row_of(m, "plain_rope"))
    assert not ed._ig_enabled.isChecked() and not ed._ig_body.isEnabled()
    ed._apply()
    assert "igniter" not in m.items[_row_of(m, "plain_rope")]


def test_checking_writes_seed_object_without_uses(editor) -> None:
    ed, m = editor([PLAIN])
    ed._list.setCurrentRow(0)
    ed._ig_enabled.setChecked(True)
    assert ed._is_dirty()
    ed._apply()
    assert m.items[0]["igniter"] == {"seconds": 1, "windLimit": 5}
    assert isinstance(m.items[0]["igniter"]["seconds"], int), "整数落 int，不写成 1.0"
    assert not ed._is_dirty()
    # uses 改成 3 ⇒ 写键；改回 1 ⇒ 盘上已写着 uses 就写 1
    ed._ig_uses.setValue(3)
    ed._apply()
    assert m.items[0]["igniter"] == {"seconds": 1, "windLimit": 5, "uses": 3}
    ed._ig_uses.setValue(1)
    ed._apply()
    assert m.items[0]["igniter"]["uses"] == 1


def test_untouched_uses_one_is_not_written(editor) -> None:
    ed, m = editor([YANGHUO])
    ed._list.setCurrentRow(0)
    ed._ig_seconds.setValue(0.75)
    ed._apply()
    assert m.items[0]["igniter"] == {"seconds": 0.75, "windLimit": 10}, "缺省 uses 不许凭空长出来"


def test_editing_one_key_keeps_the_rest_byte_for_byte(editor) -> None:
    item = {**PLAIN, "igniter": {"note": "留着", "windLimit": 6.0, "seconds": "慢", "uses": 3}}
    ed, m = editor([item])
    ed._list.setCurrentRow(0)
    ed._ig_wind.setValue(7.5)
    assert ed._is_dirty()
    ed._apply()
    assert list(m.items[0]["igniter"].items()) == [("note", "留着"), ("windLimit", 7.5), ("seconds", "慢"), ("uses", 3)]


def test_edit_is_dirty_and_commits_on_leave(editor) -> None:
    ed, m = editor(_items())
    ed._list.setCurrentRow(_row_of(m, "huorong"))
    ed._ig_seconds.setValue(3.25)
    assert ed._is_dirty(), "改了火种必须判脏，否则切走即丢"
    ed._list.setCurrentRow(_row_of(m, "plain_rope"))   # 切走，不点 Apply
    assert m.items[_row_of(m, "huorong")]["igniter"] == {"uses": 1, "seconds": 3.25, "windLimit": 3}


def test_commit_pending_on_leave_hook_commits_igniter(editor) -> None:
    ed, m = editor([HUOZHEZI])
    ed._list.setCurrentRow(0)
    ed._ig_uses.setValue(4)
    assert ed.commit_pending_on_leave()
    assert m.items[0]["igniter"]["uses"] == 4


def test_unchecking_deletes_the_key(editor) -> None:
    for item in (HUORONG, BOGUS):
        ed, m = editor([item])
        ed._list.setCurrentRow(0)
        if not ed._ig_enabled.isChecked():
            ed._ig_enabled.setChecked(True)
        ed._ig_enabled.setChecked(False)
        assert ed._is_dirty()
        ed._apply()
        assert "igniter" not in m.items[0], "不勾＝删键，不是写空对象"
        ed.deleteLater()


def test_rechecking_a_bogus_value_writes_a_real_object(editor) -> None:
    ed, m = editor([BOGUS])
    ed._list.setCurrentRow(0)
    assert not ed._ig_enabled.isChecked(), "非对象不当勾着"
    ed._ig_enabled.setChecked(True)
    ed._apply()
    assert m.items[0]["igniter"] == {"seconds": 1, "windLimit": 5}


def test_hint_labels_explain_the_synthesized_button(editor) -> None:
    ed, m = editor(_items())
    ed._list.setCurrentRow(_row_of(m, "huorong"))
    assert not ed._u_igniter_hint.isHidden()
    assert "自动给「设为火种」" in ed._u_igniter_hint.text()
    assert "自动给「设为火种」" in ed._ig_hint.text()
    ed._u_enabled.setChecked(True)
    assert "不给「设为火种」" in ed._u_igniter_hint.text() and "setActiveIgniter" in ed._u_igniter_hint.text()
    ed._list.setCurrentRow(_row_of(m, "plain_rope"))
    assert ed._u_igniter_hint.isHidden()


def test_bad_disk_values_are_called_out(editor) -> None:
    ed, _m = editor([{**PLAIN, "igniter": {"windLimit": "大", "uses": 2.5, "note": 1}}])
    ed._list.setCurrentRow(0)
    text = ed._ig_hint.text()
    for needle in ("缺 seconds", "windLimit", "uses", "note"):
        assert needle in text, text


# =========================================================================== #
# 6. json_lang
# =========================================================================== #

def _json_lang_root(tmp_path: Path, items: list[dict]) -> Path:
    data = tmp_path / "public/assets/data"
    data.mkdir(parents=True)
    (tmp_path / "public/assets/scenes").mkdir(parents=True)
    (tmp_path / "public/assets/dialogues/graphs").mkdir(parents=True)
    (data / "items.json").write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    return tmp_path


def test_json_lang_igniter_universe(tmp_path: Path) -> None:
    from tools.json_lang.id_universes import collect_id_universes

    ud = collect_id_universes(_json_lang_root(tmp_path, _items()))
    assert ud.ids["igniter_items"] == ["huorong", "huozhezi", "yanghuo"]
    assert ud.labels["igniter_items"]["huozhezi"] == "火折子"
    assert set(ud.ids["igniter_items"]) < set(ud.ids["items"])


def test_json_lang_schema_narrows_set_active_igniter_item(tmp_path: Path) -> None:
    from tools.json_lang.extract import extract_language_spec
    from tools.json_lang.id_universes import collect_id_universes
    from tools.json_lang.schema_build import build_schema

    spec = extract_language_spec(_ROOT)
    assert not [w for w in spec.warnings if ACT in w], spec.warnings
    ud = collect_id_universes(_json_lang_root(tmp_path, _items()))
    schema = build_schema(spec, ud)
    variants = [v for v in schema["definitions"]["actionDef"]["allOf"]
                if v["if"]["properties"]["type"].get("const") == ACT]
    assert len(variants) == 1
    params = variants[0]["then"]["properties"]["params"]
    assert params["required"] == ["item"]
    assert params["properties"]["item"]["enum"] == ["huorong", "huozhezi", "yanghuo"]

    jsonschema = pytest.importorskip("jsonschema")
    v = jsonschema.Draft7Validator(schema)
    good = [{"use": {"actions": [{"type": ACT, "params": {"item": "yanghuo"}}]}}]
    bad = [{"use": {"actions": [{"type": ACT, "params": {"item": "plain_rope"}}]}}]
    assert list(v.iter_errors(good)) == []
    assert list(v.iter_errors(bad)), "非火种物品应当场报"
