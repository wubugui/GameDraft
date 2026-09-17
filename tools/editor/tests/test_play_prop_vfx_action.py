"""`playPropVfx`（在手持挂件上播一个效果）的编辑器侧登记面 + 往返 + 校验器契约。

登记面清单见 agent_docs `runtime/mechanisms/action-registration-registry-surfaces.md`；三方 parity
（运行时 register ↔ ACTION_TYPES ↔ TS manifest）由既有护栏覆盖，本文件补它们盖不到的面：

1. 编辑器授权面：ACTION_TYPES / _PARAM_SCHEMAS / 持久化档 / 过场白名单 / 实体引用登记 / json_lang 引用宇宙；
2. 往返：最小形态 `{effect}`（挂件状态进入动作里最常见的形态）逐字节不长键；填满形态保值；
   `point` 的「不写」档真的存得下去、没动过的坏形态原样回吐；
3. 控件：effect 走效果选择器、target 走演员选择器、socket 按 target 派生候选、point 带「写」勾选；
4. 校验器：**位置规则**——只有挂件预设状态 `onEnterActions` 的顶层可以不写 target / socket，
   嵌套在容器里的与别处一律 error；effect 空 / 悬垂 error；point 形状；放不完的效果 warning；
5. 挂件预设页：进入时动作里放一条最小形态的 playPropVfx，打开→不动→保存不脏不漂、保存门不拦。
"""
from __future__ import annotations

import copy
import json
import os
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
    _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT,
    _OMIT_WHEN_ABSENT_AND_DEFAULT,
    _PARAM_SCHEMAS,
    ActionEditor,
    ActionRow,
    FilterableTypeCombo,
)
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402

ACT = "playPropVfx"
_REAL_IMAGE = "/resources/runtime/images/icons/taomu_sword.png"
_CONTEXT_ERR = "playPropVfx 在挂件状态进入动作之外必须写 target 与 socket"


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app) -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
    return m


def _known_effect(model: ProjectModel) -> str:
    """仓库里一份放得完的真效果（没有一直发的发射器），校验器对它不该出任何告警。"""
    from tools.editor.validator import _vfx_effect_endless_emitters

    for eid, doc in sorted(model.vfx_effects.items()):
        if isinstance(doc, dict) and not _vfx_effect_endless_emitters(doc):
            return str(eid)
    pytest.skip("仓库里没有放得完的效果资产")


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


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


# --------------------------------------------------------------------------- #
# 登记面
# --------------------------------------------------------------------------- #

def test_registered_on_every_editor_surface() -> None:
    assert ACT in ACTION_TYPES and ACT in CONTENT_ACTION_TYPES, "编辑器类型下拉里选不到"
    assert [n for n, _k in _PARAM_SCHEMAS[ACT]] == ["target", "socket", "effect", "point"]
    # 纯表演：挂件上的效果不入档（与 playVfx 同档）
    assert ACTION_PERSISTENCE.get(ACT) == "memory"


def test_in_cutscene_allowlist_and_runtime_register_names() -> None:
    allow = json.loads((_ROOT / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert ACT in allow, "纯表演动作必须进过场白名单，否则过场里被静默跳过"
    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    assert f"executor.register('{ACT}'" in reg
    assert "['target', 'socket', 'effect', 'point']" in reg[reg.index(f"executor.register('{ACT}'"):], \
        "register 的 paramNames 与编辑器 schema 对不上"


def test_entity_ref_and_json_lang_universe_are_registered() -> None:
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS

    assert ENTITY_REF_PARAMS.get(ACT) == {"target": "actor"}, "target 与 setPropState 同一命中面"
    assert CONTENT_ID_PARAMS.get((ACT, "effect")) == "vfx_effects"
    assert CONTENT_ID_PARAMS.get((ACT, "effect")) == CONTENT_ID_PARAMS.get(("playVfx", "effect"))


def test_optional_params_with_widgets_are_covered_by_a_roundtrip_table() -> None:
    """target / socket 进**作用域**剔除表（它们在 attachToSocket / setPropState 里是必填，进全局表会误伤）；
    point 的控件自带「不写」档，不需要剔除表。"""
    for pname in ("target", "socket"):
        assert _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT.get((ACT, pname)) == ""
        assert pname not in _OMIT_WHEN_ABSENT_AND_DEFAULT
    assert (ACT, "point") not in _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT


# --------------------------------------------------------------------------- #
# 往返
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("scene", [False, True])
def test_minimal_form_roundtrips_byte_for_byte(model, scene) -> None:
    """挂件预设状态进入动作里的形态：只有 effect。不得凭空长出 target:"" / socket:"" / point。"""
    sid = (model.all_scene_ids() or [None])[0] if scene else None
    act = {"type": ACT, "params": {"effect": "torch_snuff_smoke"}}
    assert _dumps(_roundtrip(model, act, sid)) == _dumps(act)


def test_filled_forms_roundtrip(model) -> None:
    for act in (
        {"type": ACT, "params": {"target": "player", "socket": "right_hand", "effect": "torch_snuff"}},
        {"type": ACT, "params": {"target": "player", "socket": "right_hand", "effect": "torch_snuff",
                                 "point": [0.5, 0]}},
        {"type": ACT, "params": {"effect": "torch_snuff", "point": [0.25, 0.125]}},
        # 显式空串（作者自己写的）原样保留——剔除只针对"原本就没有这个键"
        {"type": ACT, "params": {"target": "", "socket": "", "effect": "torch_snuff"}},
    ):
        out = _roundtrip(model, act)
        assert _dumps(out) == _dumps(act), act
    out = _roundtrip(model, {"type": ACT, "params": {"effect": "x", "point": [0.5, 0]}})
    assert isinstance(out["params"]["point"][1], int), "0 不得漂成 0.0"


def test_dangling_values_are_preserved(model) -> None:
    act = {"type": ACT, "params": {"target": "绝不存在的人", "socket": "绝不存在的挂点",
                                   "effect": "绝不存在的效果"}}
    assert _roundtrip(model, act) == act


@pytest.mark.parametrize("raw", [[2, -1], ["0.5", 0.5], [0.5], "0.5,0.5", [0.1, 0.2, 0.3], None])
def test_untouched_odd_point_is_passed_through(model, raw) -> None:
    """越界 / 字符串 / 形状坏 / null：运行时自己清洗，编辑器没动过就不替它"修"。"""
    act = {"type": ACT, "params": {"effect": "torch_snuff", "point": raw}}
    assert _roundtrip(model, act) == act


def test_point_checkbox_writes_and_removes_the_key(model, app) -> None:
    """从控件入口改：勾上写 [u, v]；把盘上已有的点取消勾选 = 不写键（末尾的原值透传不许把它塞回来）。"""
    from tools.editor.editors.prop_preset_blocks import OptionalPointField

    ed = ActionEditor("t")
    ed.set_project_context(model, None)
    ed.set_data([{"type": ACT, "params": {"effect": "torch_snuff"}}])
    try:
        w = ed._rows[0]._param_widgets["point"]
        assert isinstance(w, OptionalPointField)
        assert w.point() is None, "缺键 = 不勾（不写）"
        w._on.setChecked(True)
        w._spins[0].setValue(0.25)
        assert ed.to_list()[0]["params"]["point"] == [0.25, 0.1]
    finally:
        ed.deleteLater()

    ed = ActionEditor("t")
    ed.set_project_context(model, None)
    ed.set_data([{"type": ACT, "params": {"effect": "torch_snuff", "point": [0.3, 0.4]}}])
    try:
        w = ed._rows[0]._param_widgets["point"]
        assert w.point() == (0.3, 0.4)
        w._on.setChecked(False)
        assert ed.to_list()[0]["params"] == {"effect": "torch_snuff"}
    finally:
        ed.deleteLater()


# --------------------------------------------------------------------------- #
# 控件
# --------------------------------------------------------------------------- #

def test_widgets_follow_the_selector_rule(model, app) -> None:
    from tools.editor.editors.prop_preset_blocks import OptionalPointField

    sid = (model.all_scene_ids() or [None])[0]
    row = ActionRow({"type": ACT, "params": {"target": "player", "socket": "", "effect": ""}},
                    model=model, scene_id=sid)
    try:
        ws = row._param_widgets
        for name, w in ws.items():
            assert type(w) is not QLineEdit, f"{ACT}.{name} 是裸 QLineEdit（违选择器铁律）"
        assert isinstance(ws["effect"], IdRefSelector)
        assert getattr(ws["effect"], "_content_id_universe", None) == "vfx_effects"
        assert isinstance(ws["target"], IdRefSelector)
        assert isinstance(ws["socket"], FilterableTypeCombo)
        assert isinstance(ws["point"], OptionalPointField)
        expect = {n for n, _l in (model.socket_names_for_actor(sid, "player") or [])}
        got = {v for _lab, v in ws["socket"]._entries}
        assert expect <= got, f"socket 候选没从 player 的动画包派生：{sorted(got)}"
        empty_rows = [lab for lab, v in ws["socket"]._entries if v == ""]
        assert empty_rows and "这件挂件" in empty_rows[0], "空值那一行要说清在挂件状态进入动作里 = 这件挂件"
        assert "这件挂件" in ws["target"].toolTip() and "这件挂件" in ws["socket"].toolTip()
    finally:
        row.deleteLater()


# --------------------------------------------------------------------------- #
# 校验器
# --------------------------------------------------------------------------- #

def _issues(model, act: dict, **kw) -> list:
    from tools.editor.validator import _append_action_param_ref_issues

    out: list = []
    _append_action_param_ref_issues(model, out, act, "probe", "p", None, **kw)
    return out


def _errors(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "error"]


def _warnings(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "warning"]


def test_written_out_form_is_clean_everywhere(model) -> None:
    eff = _known_effect(model)
    act = {"type": ACT, "params": {"target": "player", "socket": "right_hand", "effect": eff, "point": [0.5, 0.1]}}
    assert [i.message for i in _issues(model, act)] == []


@pytest.mark.parametrize("params", [
    {"effect": "E"},
    {"target": "player", "effect": "E"},
    {"socket": "right_hand", "effect": "E"},
    {"target": "  ", "socket": "right_hand", "effect": "E"},
])
def test_empty_target_or_socket_outside_prop_state_is_an_error(model, params) -> None:
    eff = _known_effect(model)
    p = {k: (eff if v == "E" else v) for k, v in params.items()}
    errs = _errors(_issues(model, {"type": ACT, "params": p}))
    assert any(_CONTEXT_ERR in m for m in errs), errs
    # 在挂件状态进入动作顶层：同一条动作不报
    assert not any(_CONTEXT_ERR in m for m in _errors(_issues(model, {"type": ACT, "params": p},
                                                                prop_state_self=True)))


def test_effect_must_be_given_and_exist(model) -> None:
    errs = _errors(_issues(model, {"type": ACT, "params": {"target": "player", "socket": "h"}}))
    assert any("playPropVfx 缺 effect" in m for m in errs), errs
    errs = _errors(_issues(model, {"type": ACT, "params": {"effect": "  "}}, prop_state_self=True))
    assert any("playPropVfx 缺 effect" in m for m in errs), errs
    errs = _errors(_issues(model, {"type": ACT, "params": {"effect": "绝不存在的效果"}}, prop_state_self=True))
    assert any("绝不存在的效果" in m and "assets/data/vfx/" in m for m in errs), errs


@pytest.mark.parametrize("raw,sev,frag", [
    ("0.5,0.5", "error", "point 须为 [u, v]"),
    ({"u": 0.5}, "error", "point 须为 [u, v]"),
    ([0.5], "error", "point 须为 [u, v]"),
    (["左", 0.5], "error", "point 须为 [u, v]"),
    ([0.5, float("nan")], "error", "point 须为 [u, v]"),
    ([1.5, 0.5], "warning", "超出 0..1"),
    ([0.5, -0.1], "warning", "超出 0..1"),
    (["0.5", 0.5], "warning", "非数值"),
])
def test_point_shape(model, raw, sev, frag) -> None:
    eff = _known_effect(model)
    issues = _issues(model, {"type": ACT, "params": {"effect": eff, "point": raw}}, prop_state_self=True)
    hits = [i for i in issues if i.severity == sev and frag in i.message]
    assert hits, [f"{i.severity}:{i.message}" for i in issues]
    if sev == "warning":
        assert _errors(issues) == [], "运行时照用（强转 / 夹取）的写法不许拦保存（兜底 ⊆ TS 权威）"


@pytest.mark.parametrize("raw", [[0, 1], [0.5, 0.1], [1, 1.0, 9]])
def test_valid_point_is_clean(model, raw) -> None:
    eff = _known_effect(model)
    issues = _issues(model, {"type": ACT, "params": {"effect": eff, "point": raw}}, prop_state_self=True)
    assert [i.message for i in issues] == []


def test_endless_effect_warns(model) -> None:
    """有 rate 没 duration（或群体）的效果放不完——playPropVfx 靠"放完自己收"，会一直冒到挂件卸下。"""
    from tools.editor.validator import _vfx_effect_endless_emitters

    base = {"appearance": {"image": "/x.png", "sizeWu": 3}}
    cases = {
        "zz_rate_forever": ([{"id": "a", **base, "spawn": {"max": 5, "rate": 4}}], ["a"]),
        "zz_rate_timed": ([{"id": "a", **base, "spawn": {"max": 5, "rate": 4, "duration": 0.5}}], []),
        "zz_burst_only": ([{"id": "a", **base, "spawn": {"max": 5, "burst": 5}}], []),
        "zz_sub_only": ([{"id": "a", **base, "spawn": {"max": 5, "burst": 1}},
                         {"id": "b", **base, "subOnly": True, "spawn": {"max": 5, "rate": 9}}], []),
        "zz_flock": ([{"id": "bats", **base, "spawn": {"max": 5}, "behavior": {"cruise": 1}}], ["bats"]),
    }
    saved = model.vfx_effects
    model.vfx_effects = {**saved, **{k: {"id": k, "emitters": ems} for k, (ems, _want) in cases.items()}}
    try:
        for eid, (ems, want) in cases.items():
            assert _vfx_effect_endless_emitters({"id": eid, "emitters": ems}) == want, eid
            warns = _warnings(_issues(model, {"type": ACT, "params": {"effect": eid}}, prop_state_self=True))
            msg = f"效果「{eid}」有一直发的发射器，playPropVfx 会一直冒到挂件卸下"
            assert any(msg in m for m in warns) == bool(want), (eid, warns)
    finally:
        model.vfx_effects = saved


# ---- 位置规则经挂件预设的真入口（_validate_prop_presets → onEnterActions 顶层 / 嵌套）----

def _prop_issues(model, on_enter: list) -> list:
    from tools.editor.validator import _validate_prop_presets

    saved = model.prop_presets
    model.prop_presets = {"zz_torch": {
        "image": _REAL_IMAGE,
        "states": {"lit": {}, "out": {"onEnterActions": copy.deepcopy(on_enter)}},
        "defaultState": "lit",
    }}
    try:
        out: list = []
        _validate_prop_presets(model, out)
        return out
    finally:
        model.prop_presets = saved


def test_top_level_on_enter_action_may_omit_target_and_socket(model) -> None:
    eff = _known_effect(model)
    issues = _prop_issues(model, [{"type": ACT, "params": {"effect": eff}}])
    assert [i.message for i in issues] == []


@pytest.mark.parametrize("wrap", [
    lambda a: {"type": "runActions", "params": {"actions": [a]}},
    lambda a: {"type": "runActionsIf", "params": {"condition": {"flag": "x"}, "actions": [], "elseActions": [a]}},
    lambda a: {"type": "chooseAction", "params": {"options": [{"text": "吹", "actions": [a]}]}},
    lambda a: {"type": "randomBranch", "params": {"probability": 0.5, "aboveActions": [a], "belowActions": []}},
])
def test_nested_on_enter_action_is_not_injected(model, wrap) -> None:
    """运行时只给**顶层**注入：嵌在容器里的 playPropVfx 留空 = 缺 target / socket（warn 跳过）。"""
    eff = _known_effect(model)
    issues = _prop_issues(model, [wrap({"type": ACT, "params": {"effect": eff}})])
    assert any(_CONTEXT_ERR in m for m in _errors(issues)), [i.message for i in issues]
    # 写全了嵌套的也不报
    full = _prop_issues(model, [wrap({"type": ACT, "params": {
        "target": "player", "socket": "right_hand", "effect": eff}})])
    assert not any(_CONTEXT_ERR in m for m in _errors(full)), [i.message for i in full]


def test_other_hosts_are_not_prop_state_context(model) -> None:
    """别的动作宿主（这里用任务 / 通用遍历入口）一律按"别处"判。"""
    from tools.editor.validator import _walk_action_defs

    eff = _known_effect(model)
    out: list = []
    _walk_action_defs(model, out, [{"type": ACT, "params": {"effect": eff}}], "quest", "q", None)
    assert any(_CONTEXT_ERR in m for m in _errors(out)), [i.message for i in out]


# --------------------------------------------------------------------------- #
# 挂件预设页
# --------------------------------------------------------------------------- #

def test_prop_preset_editor_roundtrips_state_enter_action_and_save_gate_passes(model, app) -> None:
    from tools.editor.editors.prop_preset_editor import PropPresetEditor
    from tools.editor.shared.ref_validator import validate_refs_for_save

    table = {"zz_torch": {
        "image": _REAL_IMAGE,
        "states": {
            "lit": {},
            "out": {"onEnterActions": [{"type": ACT, "params": {"effect": "torch_snuff_smoke"}}]},
        },
        "defaultState": "lit",
    }}
    saved_table, saved_dirty = model.prop_presets, set(model._dirty)
    model.prop_presets = copy.deepcopy(table)
    model._dirty.clear()
    ed = PropPresetEditor(model)
    try:
        ed._refresh(keep="zz_torch")
        se = ed._states_editor
        se.ensure_built()            # 真的把状态表建出来，让进入动作经过 ActionEditor 控件
        se._on_select("out")
        acts = se._st_on_enter.to_list()
        assert acts == [{"type": ACT, "params": {"effect": "torch_snuff_smoke"}}], acts
        assert ACT in {v for _lab, v in se._st_on_enter._rows[0].type_combo._entries}, "进入时动作里选得到"
        se._on_select("lit")         # commit-on-leave：没动过就原样回吐
        staged = ed._staged()
        assert not ed._dirty, "打开即脏是红线"
        assert _dumps(staged) == _dumps(table)
        ed.flush_to_model(True)
        assert validate_refs_for_save(model, dirty={"prop_presets"}) is None
        hint = se._st_on_enter_hint
        assert "playPropVfx" in hint.text() and "这件挂件" in hint.text()
    finally:
        ed.deleteLater()
        model.prop_presets = saved_table
        model._dirty.clear()
        model._dirty.update(saved_dirty)
