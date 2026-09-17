"""风吹灭（挂件预设 `blowout`）/ 玩家操作（`playerControl`）/ `lockPropState` 在编辑器侧的登记面。

运行时权威：`src/data/propPresets.ts`（`parseBlowout` / `parsePlayerControl`）、`HeldPropSystem.stepBlowout` /
`crossLine`、`src/core/ActionRegistry.ts` 的 `lockPropState`。覆盖（每条对应一个"漏了会静默"的口子）：

1. `lockPropState` 登记面：ACTION_TYPES / _PARAM_SCHEMAS ↔ TS manifest / register 参数名 / 持久化档（save）/
   不在过场白名单 / 实体引用登记；控件（演员选择器、挂点下拉、三档锁下拉）；往返（最小形态逐字节、悬垂保值）；校验器。
2. 校验器：`blowout` 基础块 / 状态每条护栏先改坏一次；越线动作与状态进入动作走同一条动作校验链
   （未登记类型、playPropVfx 顶层可省 target / socket、嵌套的不省）；`playerControl` 护栏。
3. 动作扫描面：越线动作列表进动作总表、保存门 [tag:] 校验、flag 汇总、实发信号目录、信号改名、信号关系（xref）、实体引用扫描。
4. 挂件预设页：真实数据 / 合成形态打开→不动→保存逐字节；风吹灭块、状态三态、玩家操作块从控件入口改一次看产物。
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

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    _PARAM_SCHEMAS,
    ActionEditor,
    ActionRow,
    FilterableTypeCombo,
)
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402

LOCK = "lockPropState"
_REAL_IMAGE = "/resources/runtime/images/icons/taomu_sword.png"
_CONTEXT_ERR = "playPropVfx 在挂件状态进入动作之外必须写 target 与 socket"
_UNREGISTERED = "未在 action_editor.ACTION_TYPES 中登记"


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app) -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
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
# lockPropState
# =========================================================================== #

def test_lock_registered_on_every_editor_surface() -> None:
    assert LOCK in ACTION_TYPES and LOCK in CONTENT_ACTION_TYPES, "编辑器类型下拉里选不到"
    man = _manifest_entry(LOCK)
    names = [n for n, _k in _PARAM_SCHEMAS[LOCK]]
    assert set(names) == man["required"] | man["optional"], (names, man)
    assert man["required"] == {"target", "socket", "lock"} and man["nonEmpty"] == {"target", "socket", "lock"}
    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    i = reg.index(f"executor.register('{LOCK}'")
    assert "['target', 'socket', 'lock']" in reg[i:i + 1500], "register 的 paramNames 与编辑器 schema 对不上"
    # 锁跟着手持物入档 ⇒ save；也因此不许进过场白名单（过场内禁改存档）
    assert ACTION_PERSISTENCE.get(LOCK) == "save"
    allow = json.loads((_ROOT / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert LOCK not in allow


def test_lock_target_is_a_registered_actor_ref() -> None:
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
    from tools.editor.validator import _actor_ref_keys

    assert ENTITY_REF_PARAMS.get(LOCK) == ENTITY_REF_PARAMS.get("setPropState") == {"target": "actor"}
    assert _actor_ref_keys(LOCK) == ("target",)


def test_lock_values_match_runtime() -> None:
    """下拉三档与运行时认的三档同一份（ActionRegistry 里 lit / unlit / none，别的当 none）。"""
    from tools.editor.shared.action_editor import _PROP_LOCK_ROWS
    from tools.editor.validator import _PROP_LOCK_VALUES

    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    i = reg.index(f"executor.register('{LOCK}'")
    runtime = set(re.findall(r"raw === '([a-z]+)'", reg[i:i + 1500]))
    assert runtime == set(_PROP_LOCK_VALUES) == {v for v, _l in _PROP_LOCK_ROWS if v}


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


@pytest.mark.parametrize("lock", ["lit", "unlit", "none"])
@pytest.mark.parametrize("scene", [False, True])
def test_lock_minimal_form_roundtrips_byte_for_byte(model, lock, scene) -> None:
    sid = (model.all_scene_ids() or [None])[0] if scene else None
    act = {"type": LOCK, "params": {"target": "player", "socket": "right_hand", "lock": lock}}
    assert _dumps(_roundtrip(model, act, sid)) == _dumps(act)


def test_lock_dangling_values_are_preserved(model) -> None:
    act = {"type": LOCK, "params": {"target": "绝不存在的人", "socket": "绝不存在的挂点", "lock": "locked"}}
    assert _roundtrip(model, act) == act


def test_lock_widgets_follow_the_selector_rule(model, app) -> None:
    sid = (model.all_scene_ids() or [None])[0]
    row = ActionRow({"type": LOCK, "params": {"target": "player", "socket": "", "lock": "none"}},
                    model=model, scene_id=sid)
    try:
        ws = row._param_widgets
        for name, w in ws.items():
            assert type(w) is not QLineEdit, f"{LOCK}.{name} 是裸 QLineEdit（违选择器铁律）"
        assert isinstance(ws["target"], IdRefSelector)
        assert isinstance(ws["socket"], FilterableTypeCombo)
        assert isinstance(ws["lock"], FilterableTypeCombo)
        expect = {n for n, _l in (model.socket_names_for_actor(sid, "player") or [])}
        assert expect <= {v for _lab, v in ws["socket"]._entries}, "socket 候选没从 player 的动画包派生"
        assert {v for _lab, v in ws["lock"]._entries} == {"", "lit", "unlit", "none"}
        tip = ws["lock"].toolTip()
        for needle in ("锁定不灭", "点不燃", "解锁", "setPropState"):
            assert needle in tip
    finally:
        row.deleteLater()


def test_lock_widget_writes_the_picked_value(model, app) -> None:
    ed = ActionEditor("t")
    ed.set_project_context(model, None)
    ed.set_data([{"type": LOCK, "params": {"target": "player", "socket": "right_hand", "lock": "none"}}])
    try:
        w = ed._rows[0]._param_widgets["lock"]
        w.set_committed_type("lit")
        assert ed.to_list()[0]["params"] == {"target": "player", "socket": "right_hand", "lock": "lit"}
    finally:
        ed.deleteLater()


def _param_issues(model, act: dict) -> list:
    from tools.editor.validator import _append_action_param_ref_issues

    out: list = []
    _append_action_param_ref_issues(model, out, act, "probe", "p", None)
    return out


def _errors(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "error"]


def _warnings(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "warning"]


@pytest.mark.parametrize("lock", ["lit", "unlit", "none"])
def test_lock_valid_form_is_clean(model, lock) -> None:
    from tools.editor.validator import _walk_action_defs

    out: list = []
    _walk_action_defs(model, out, [{"type": LOCK, "params": {
        "target": "player", "socket": "right_hand", "lock": lock}}], "quest", "q", None)
    assert [i.message for i in out] == []


@pytest.mark.parametrize("params,frag", [
    ({"socket": "h", "lock": "lit"}, "lockPropState 缺 target"),
    ({"target": "player", "socket": " ", "lock": "lit"}, "lockPropState 缺 socket"),
    ({"target": "player", "socket": "h"}, "lockPropState 缺 lock"),
    ({"target": "player", "socket": "h", "lock": ""}, "lockPropState 缺 lock"),
    ({"target": "player", "socket": "h", "lock": "locked"}, "运行时不认"),
    ({"target": "player", "socket": "h", "lock": True}, "lockPropState 缺 lock"),
])
def test_lock_bad_forms_are_errors(model, params, frag) -> None:
    errs = _errors(_param_issues(model, {"type": LOCK, "params": params}))
    assert any(frag in m for m in errs), errs


# =========================================================================== #
# 校验器：blowout
# =========================================================================== #

GOOD_BLOWOUT = {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3, "emberBelow": 0.35, "fadeMs": 500}
STATES4 = {"lit": {}, "guarding": {}, "ember": {}, "out": {}}


def _preset_issues(model, entry: dict) -> list:
    from tools.editor.validator import _validate_prop_presets

    saved = model.prop_presets
    model.prop_presets = {"zz": copy.deepcopy(entry)}
    try:
        out: list = []
        _validate_prop_presets(model, out)
        return out
    finally:
        model.prop_presets = saved


def _entry(blowout: object = GOOD_BLOWOUT, states: dict | None = None, **extra) -> dict:
    e = {"image": _REAL_IMAGE, "states": copy.deepcopy(STATES4 if states is None else states),
         "defaultState": "lit", **extra}
    if blowout is not ...:
        e["blowout"] = copy.deepcopy(blowout)
    return e


def _known_effect(model: ProjectModel) -> str:
    from tools.editor.validator import _vfx_effect_endless_emitters

    for eid, doc in sorted(model.vfx_effects.items()):
        if isinstance(doc, dict) and not _vfx_effect_endless_emitters(doc):
            return str(eid)
    pytest.skip("仓库里没有放得完的效果资产")


def test_healthy_blowout_forms_are_clean(model) -> None:
    eff = _known_effect(model)
    full = {**GOOD_BLOWOUT, "emberState": "ember", "outState": "out", "auto": False,
            "onEmberActions": [{"type": "playPropVfx", "params": {"effect": eff}}],
            "onOutActions": [{"type": "playPropVfx", "params": {"effect": eff}}]}
    for entry in (
        _entry(),
        _entry(full),
        _entry({"windSpeed": 8.5, "drainSeconds": 1, "recoverSeconds": 0.5}),
        _entry(GOOD_BLOWOUT, states={**STATES4, "guarding": {"blowout": None}}),
        _entry(..., states={**STATES4, "lit": {"blowout": full}}),
    ):
        assert [i.message for i in _preset_issues(model, entry)] == [], entry


@pytest.mark.parametrize("key", ["windSpeed", "drainSeconds", "recoverSeconds"])
@pytest.mark.parametrize("bad", [..., 0, -1, None, "快", float("nan"), {}])
def test_required_numbers_must_be_positive(model, key, bad) -> None:
    blk = dict(GOOD_BLOWOUT)
    if bad is ...:
        blk.pop(key)
    else:
        blk[key] = bad
    errs = _errors(_preset_issues(model, _entry(blk)))
    assert any(f"blowout.{key}" in m and "吹不灭" in m for m in errs), errs
    errs = _errors(_preset_issues(model, _entry(GOOD_BLOWOUT, states={**STATES4, "lit": {"blowout": blk}})))
    assert any(f"states[lit].blowout.{key}" in m and "沿用基础块" in m for m in errs), errs


def test_coerced_required_number_is_only_a_warning(model) -> None:
    issues = _preset_issues(model, _entry({**GOOD_BLOWOUT, "windSpeed": "8"}))
    assert _errors(issues) == []
    assert any("blowout.windSpeed" in m and "Number()" in m for m in _warnings(issues))


def test_base_block_must_be_an_object(model) -> None:
    for bad in (None, 5, "on", [GOOD_BLOWOUT]):
        errs = _errors(_preset_issues(model, _entry(bad)))
        assert any(m.startswith("blowout ") for m in errs), (bad, errs)


def test_state_null_is_meaningful_but_state_non_object_is_an_error(model) -> None:
    ok = _preset_issues(model, _entry(GOOD_BLOWOUT, states={**STATES4, "lit": {"blowout": None}}))
    assert [i.message for i in ok] == []
    errs = _errors(_preset_issues(model, _entry(GOOD_BLOWOUT, states={**STATES4, "lit": {"blowout": 3}})))
    assert any("states[lit].blowout 须为对象" in m and "沿用基础块" in m for m in errs), errs


@pytest.mark.parametrize("raw,frag", [(1.5, "超出 0..1"), (-0.2, "超出 0..1"), ("半", "读不出数"), ("0.3", "Number()")])
def test_ember_below_warnings(model, raw, frag) -> None:
    issues = _preset_issues(model, _entry({**GOOD_BLOWOUT, "emberBelow": raw}))
    assert _errors(issues) == []
    assert any("emberBelow" in m and frag in m for m in _warnings(issues)), _warnings(issues)


def test_state_names_must_exist(model) -> None:
    w = _warnings(_preset_issues(model, _entry({**GOOD_BLOWOUT, "emberState": "coal", "outState": "dead"})))
    assert any("emberState 'coal'" in m for m in w) and any("outState 'dead'" in m for m in w), w
    # 缺省名对不上也要说（风吹到那一步切不过去）
    w = _warnings(_preset_issues(model, _entry(GOOD_BLOWOUT, states={"lit": {}})))
    assert any("emberState 'ember'（缺省）" in m for m in w) and any("outState 'out'（缺省）" in m for m in w), w
    # 没写残炭线就没有残炭这一步：缺省 ember 不存在不报
    w = _warnings(_preset_issues(model, _entry({"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3},
                                               states={"lit": {}, "out": {}})))
    assert not any("emberState" in m for m in w), w
    # auto: false 只执行动作：缺省名不存在不报，显式写错的照报
    w = _warnings(_preset_issues(model, _entry({**GOOD_BLOWOUT, "auto": False}, states={"lit": {}})))
    assert not any("（缺省）" in m for m in w), w
    w = _warnings(_preset_issues(model, _entry({**GOOD_BLOWOUT, "auto": False, "outState": "dead"},
                                               states={"lit": {}})))
    assert any("outState 'dead'" in m for m in w), w
    # 非字符串
    w = _warnings(_preset_issues(model, _entry({**GOOD_BLOWOUT, "outState": 3})))
    assert any("outState 须为状态名" in m for m in w), w


def test_recover_state_must_exist(model) -> None:
    """`recoverState`（挡风复燃回到）：残炭里挡住风火势回来时切回的状态，缺省 lit；只在有残炭线时才用得到。"""
    assert [i.message for i in _preset_issues(model, _entry({**GOOD_BLOWOUT, "recoverState": "guarding"}))] == []
    w = _warnings(_preset_issues(model, _entry({**GOOD_BLOWOUT, "recoverState": "glow"})))
    assert any("recoverState 'glow'" in m and "不复燃" in m for m in w), w
    # 缺省名 lit 对不上也要说（挡住风也回不来）
    w = _warnings(_preset_issues(model, _entry(GOOD_BLOWOUT, states={"guarding": {}, "ember": {}, "out": {}})))
    assert any("recoverState 'lit'（缺省）" in m for m in w), w
    # 没写残炭线就没有复燃这一步：缺省、显式都不查
    no_ember = {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3}
    w = _warnings(_preset_issues(model, _entry({**no_ember, "recoverState": "glow"}, states={"out": {}})))
    assert not any("recoverState" in m for m in w), w
    # 状态里自己那一块同样查；非字符串
    w = _warnings(_preset_issues(model, _entry(..., states={**STATES4, "lit": {"blowout": {
        **GOOD_BLOWOUT, "recoverState": "glow"}}})))
    assert any("states[lit].blowout.recoverState 'glow'" in m for m in w), w
    w = _warnings(_preset_issues(model, _entry({**GOOD_BLOWOUT, "recoverState": 3})))
    assert any("recoverState 须为状态名" in m for m in w), w


@pytest.mark.parametrize("patch,frag", [
    ({"auto": "false"}, "auto 必须是 true/false"),
    ({"auto": 0}, "auto 必须是 true/false"),
    ({"fadeMs": -1}, "fadeMs 须为 ≥ 0"),
    ({"fadeMs": "慢"}, "fadeMs 须为 ≥ 0"),
])
def test_auto_and_fade_warnings(model, patch, frag) -> None:
    issues = _preset_issues(model, _entry({**GOOD_BLOWOUT, **patch}))
    assert _errors(issues) == []
    assert any(frag in m for m in _warnings(issues)), _warnings(issues)


def test_own_block_on_its_out_state_warns_but_inherited_does_not(model) -> None:
    w = _warnings(_preset_issues(model, _entry(GOOD_BLOWOUT, states={**STATES4, "out": {"blowout": GOOD_BLOWOUT}})))
    assert any("states[out].blowout" in m and "灭的状态里不再算" in m for m in w), w
    w = _warnings(_preset_issues(model, _entry(
        GOOD_BLOWOUT, states={**STATES4, "dead": {"blowout": {**GOOD_BLOWOUT, "outState": "dead"}}})))
    assert any("states[dead].blowout" in m and "灭的状态里不再算" in m for m in w), w
    # 基础块那份被 out 沿用是常态（现网火把就是这样）
    assert not any("灭的状态里不再算" in m for m in _warnings(_preset_issues(model, _entry())))


def test_ember_actions_without_ember_line_warn(model) -> None:
    blk = {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3,
           "onEmberActions": [{"type": "playSfx", "params": {"id": "x"}}]}
    w = _warnings(_preset_issues(model, _entry(blk)))
    assert any("onEmberActions 写了动作但没写 emberBelow" in m for m in w), w


@pytest.mark.parametrize("where", ["base", "state"])
@pytest.mark.parametrize("key", ["onEmberActions", "onOutActions"])
def test_action_lists_walk_the_same_action_chain(model, where, key) -> None:
    eff = _known_effect(model)

    def issues(acts: object) -> list:
        blk = {**GOOD_BLOWOUT, key: acts}
        if where == "base":
            return _preset_issues(model, _entry(blk))
        return _preset_issues(model, _entry(..., states={**STATES4, "lit": {"blowout": blk}}))

    # 未登记类型
    errs = _errors(issues([{"type": "__definitely_not_registered__", "params": {}}]))
    assert any(_UNREGISTERED in m for m in errs), errs
    # 顶层 playPropVfx 可省 target / socket（= 这件挂件自己）
    assert [i.message for i in issues([{"type": "playPropVfx", "params": {"effect": eff}}])] == []
    # 嵌套在容器里的不注入
    nested = [{"type": "runActions", "params": {"actions": [{"type": "playPropVfx", "params": {"effect": eff}}]}}]
    assert any(_CONTEXT_ERR in m for m in _errors(issues(nested)))
    # 形状
    assert any(f"{key} 须为动作数组" in m for m in _errors(issues("x")))
    assert any(f"{key}[0] 须为动作对象" in m for m in _errors(issues([5])))
    # 动作参数也照查（lockPropState 缺 lock）
    errs = _errors(issues([{"type": LOCK, "params": {"target": "player", "socket": "h"}}]))
    assert any("lockPropState 缺 lock" in m for m in errs), errs


def test_real_data_blowout_and_player_control_are_clean(model) -> None:
    from tools.editor.validator import _validate_prop_presets

    out: list = []
    _validate_prop_presets(model, out)
    hits = [f"{i.severity}:{i.message}" for i in out if "blowout" in i.message or "playerControl" in i.message]
    assert hits == []


# =========================================================================== #
# 校验器：playerControl
# =========================================================================== #

def test_player_control_forms(model) -> None:
    assert [i.message for i in _preset_issues(model, _entry(..., playerControl={}))] == []
    full = {"litState": "lit", "guardState": "guarding", "outState": "out", "extinguishFadeMs": 400, "igniteFadeMs": 0}
    assert [i.message for i in _preset_issues(model, _entry(..., playerControl=full))] == []
    w = _warnings(_preset_issues(model, _entry(..., states={"lit": {}, "out": {}}, playerControl={})))
    assert any("playerControl.guardState" in m and "'guarding'（缺省）" in m for m in w), w
    w = _warnings(_preset_issues(model, _entry(..., playerControl={"litState": "burning"})))
    assert any("playerControl.litState" in m and "'burning'" in m for m in w), w
    for bad in ({"extinguishFadeMs": -5}, {"igniteFadeMs": "快"}):
        w = _warnings(_preset_issues(model, _entry(..., playerControl=bad)))
        assert any("须为 ≥ 0 的毫秒数" in m for m in w), (bad, w)
    for bad in (None, 1, []):
        errs = _errors(_preset_issues(model, _entry(..., playerControl=bad)))
        assert any("playerControl 须为对象" in m for m in errs), (bad, errs)
    w = _warnings(_preset_issues(model, _entry(..., states={**STATES4, "lit": {"playerControl": {}}})))
    assert any("states[lit].playerControl 运行时不读" in m for m in w), w


@pytest.mark.parametrize("raw,frag", [
    (0, None), (1, None), (0.8, None),
    (1.5, "超出 0..1"), (-0.2, "超出 0..1"), ("半", "读不出数"), ("0.5", "Number()"), (True, "Number()"),
])
def test_player_control_hint_below(model, raw, frag) -> None:
    """快灭提示线 `hintBelow`：运行时 `parsePlayerControl` 夹到 0..1、读不出数当没写——一律只是 warning。"""
    issues = _preset_issues(model, _entry(..., playerControl={"hintBelow": raw}))
    assert _errors(issues) == []
    w = _warnings(issues)
    if frag is None:
        assert w == [], w
    else:
        assert any("playerControl.hintBelow" in m and frag in m for m in w), w


def test_player_control_hint_below_default_matches_runtime() -> None:
    from tools.editor.editors.prop_preset_blocks import PLAYER_CONTROL_HINT_BELOW_DEFAULT, PLAYER_CONTROL_KEYS
    from tools.editor.validator import _PLAYER_CONTROL_HINT_BELOW_DEFAULT

    ts = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    block = re.search(r"export const PROP_CONTROL_DEFAULTS = \{(?P<b>.*?)\} as const;", ts, re.S).group("b")
    m = re.search(r"hintBelow:\s*([\d.]+)", block)
    assert float(m.group(1)) == PLAYER_CONTROL_HINT_BELOW_DEFAULT == _PLAYER_CONTROL_HINT_BELOW_DEFAULT
    # 表单管着的键 = TS 缺省表里的键（新加字段不跟上 = 那个键被当成"不认识的键"透传、编辑不了）
    assert set(re.findall(r"(\w+):", block)) == set(PLAYER_CONTROL_KEYS)


def test_blowout_form_keys_match_runtime_type() -> None:
    from tools.editor.editors.prop_preset_blocks import BLOWOUT_KEYS

    ts = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    body = re.search(r"export interface PropBlowoutDef \{(?P<b>.*?)\n\}", ts, re.S).group("b")
    assert set(re.findall(r"^\s*(\w+)\??:", body, re.M)) == set(BLOWOUT_KEYS)


# =========================================================================== #
# 动作扫描面
# =========================================================================== #

def _scan_model(entry: dict) -> ProjectModel:
    from tempfile import TemporaryDirectory

    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    td = TemporaryDirectory()
    root = Path(td.name) / "p"
    write_minimal_loadable_project(root)
    m = ProjectModel()
    m.load_project(root)
    m._td = td   # 活到 model 被回收
    m.scenes["sc_a"]["npcs"] = [{"id": "更夫", "x": 0, "y": 0}]
    m.prop_presets = {"torch": copy.deepcopy(entry)}
    m._dirty.clear()
    return m


def _blowout_entry(ember_acts: list, out_acts: list, state_out_acts: list) -> dict:
    return {
        "image": _REAL_IMAGE,
        "blowout": {**GOOD_BLOWOUT, "onEmberActions": ember_acts, "onOutActions": out_acts},
        "states": {"lit": {"blowout": {**GOOD_BLOWOUT, "onOutActions": state_out_acts}},
                   "ember": {}, "out": {"onEnterActions": []}},
        "defaultState": "lit",
    }


def test_iter_prop_preset_action_lists_covers_every_executed_list() -> None:
    from tools.editor.shared.prop_preview import iter_prop_preset_action_lists

    e = _blowout_entry([1], [2], [3])
    e["onEnterActions"] = [9]                       # 基础块的进入动作运行时不读
    e["states"]["bad"] = {"blowout": 7}             # 坏块没有列表
    got = [(al.field, al.bracket_path, al.raw) for al in iter_prop_preset_action_lists(e)]
    assert got == [
        ("blowout.onEmberActions", "blowout.onEmberActions", [1]),
        ("blowout.onOutActions", "blowout.onOutActions", [2]),
        ("states.lit.blowout.onOutActions", "states[lit].blowout.onOutActions", [3]),
        ("states.out.onEnterActions", "states[out].onEnterActions", []),
    ]


def test_action_registry_lists_blowout_actions() -> None:
    from tools.editor.editors.action_registry_editor import _scan_actions

    m = _scan_model(_blowout_entry(
        [{"type": "playSfx", "params": {"id": "a"}}],
        [{"type": "runActions", "params": {"actions": [{"type": "emitNarrativeSignal", "params": {"signal": "s"}}]}}],
        [{"type": LOCK, "params": {"target": "player", "socket": "h", "lock": "lit"}}]))
    hits = [(r.action_type, r.container_field) for r in _scan_actions(m) if r.source_type == "prop_preset"]
    types = [t for t, _f in hits]
    assert types == ["playSfx", "runActions", "emitNarrativeSignal", LOCK], hits
    fields = " | ".join(f for _t, f in hits)
    for needle in ("blowout.onEmberActions", "blowout.onOutActions", "states.lit.blowout.onOutActions"):
        assert needle in fields, fields


def test_embedded_tag_refs_in_blowout_actions_are_save_gated() -> None:
    from tools.editor.shared.ref_validator import validate_refs_for_save

    bad = [{"type": "chooseAction", "params": {"prompt": "坏 [tag:item:__definitely_missing__]", "options": []}}]
    m = _scan_model(_blowout_entry([], [], bad))
    err = validate_refs_for_save(m, dirty={"prop_presets"})
    assert err and "prop_presets[torch].states[lit].blowout.onOutActions" in err, err
    m = _scan_model(_blowout_entry(bad, [], []))
    err = validate_refs_for_save(m, dirty={"prop_presets"})
    assert err and "prop_presets[torch].blowout.onEmberActions" in err, err


def test_all_flags_reads_blowout_actions() -> None:
    m = _scan_model(_blowout_entry(
        [{"type": "runActionsIf", "params": {"condition": {"flag": "torch_windy"}, "actions": []}}], [], []))
    assert "torch_windy" in m.all_flags()


def test_emit_narrative_signal_in_blowout_lists_is_a_real_emitter() -> None:
    from tools.editor.shared.narrative_catalog import emitted_signal_ids
    from tools.editor.shared.signal_refactor import rename_signal, scan_signal_usages
    from tools.narrative_xref.scan import build_index
    from tools.narrative_xref.sources import from_project_model

    emit = lambda sig: [{"type": "emitNarrativeSignal", "params": {"signal": sig}}]  # noqa: E731
    m = _scan_model(_blowout_entry(emit("火把快灭了"), emit("火把被风吹灭"), emit("护火时也灭了")))
    got = set(emitted_signal_ids(m))
    assert {"火把快灭了", "火把被风吹灭", "护火时也灭了"} <= got

    index = build_index(from_project_model(m))
    xref = {c.signal for c in index.overview() if c.real_emitter_count > 0}
    assert xref == got, "信号关系（xref）与实发信号目录口径分叉"
    where = index.card("火把被风吹灭").emitters[0].where
    assert "被风吹灭时" in where and "风吹灭" in where, where
    assert "onOutActions" not in where and "blowout" not in where, f"人话路径里甩了字段名：{where}"
    assert "掉到残炭时" in index.card("火把快灭了").emitters[0].where

    assets = scan_signal_usages(m, "护火时也灭了")["assets"]
    assert [(a["bucket"], a["itemId"], a["count"]) for a in assets] == [("prop_presets", "torch", 1)]
    m.narrative_graphs = {"signals": [{"id": "火把被风吹灭"}], "compositions": []}
    m._dirty.clear()
    rename_signal(m, "火把被风吹灭", "火把熄了")
    assert m.prop_presets["torch"]["blowout"]["onOutActions"][0]["params"]["signal"] == "火把熄了"
    assert "prop_presets" in m._dirty


def test_entity_usages_include_blowout_actions() -> None:
    from tools.editor.shared.entity_refactor import scan_entity_usages

    m = _scan_model(_blowout_entry(
        [], [{"type": LOCK, "params": {"target": "更夫", "socket": "right_hand", "lock": "none"}}], []))
    report = scan_entity_usages(m, "sc_a", "npc", "更夫")
    assert {"bucket": "prop_presets", "itemId": "torch", "count": 1} in report["globalRefs"]


# =========================================================================== #
# 挂件预设页
# =========================================================================== #

SYNTH_TABLE = {
    "torch": {
        "image": _REAL_IMAGE,
        "blowout": {"备注": "留着", "windSpeed": 8, "drainSeconds": 4.0, "recoverSeconds": 3,
                    "emberBelow": 0.35, "emberState": "ember", "outState": "out", "auto": True, "fadeMs": 500,
                    "onEmberActions": [{"type": "playPropVfx", "params": {"effect": "torch_snuff_smoke"}}],
                    "onOutActions": [{"type": "emitNarrativeSignal", "params": {"signal": "火把灭了"}}]},
        "playerControl": {"guardState": "guarding", "igniteFadeMs": 250, "x": [1]},
        "states": {
            "lit": {"label": "点着"},
            "guarding": {"blowout": None},
            "ember": {"blowout": {"windSpeed": 12, "drainSeconds": 2, "recoverSeconds": 1, "outState": "dead"}},
            "out": {"blowout": "坏"},
        },
        "defaultState": "lit",
    },
    "odd": {
        "image": _REAL_IMAGE,
        "blowout": {"windSpeed": 0, "drainSeconds": "4", "emberBelow": 7, "auto": "no", "fadeMs": -1,
                    "onOutActions": "x"},
        "playerControl": None,
        "states": {"lit": {"blowout": {"drainSeconds": 1}}},
    },
    "badbase": {"image": _REAL_IMAGE, "blowout": None, "playerControl": 5},
    "plain": {"image": _REAL_IMAGE, "states": {"lit": {}, "out": {}}},
    # 挡风复燃回到 / 快灭提示线：正常值、悬垂状态名、怪值、非数，打开→不动→保存都得逐字节
    "hinty": {
        "image": _REAL_IMAGE,
        "blowout": {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3, "emberBelow": 0.35,
                    "recoverState": "guarding"},
        "playerControl": {"hintBelow": 0.6, "litState": "lit"},
        "states": {"lit": {}, "guarding": {}, "ember": {"blowout": {
            "windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3, "emberBelow": 0.2, "recoverState": "ghost"}},
            "out": {}},
    },
    "hinty_odd": {
        "image": _REAL_IMAGE,
        "blowout": {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3, "recoverState": 7},
        "playerControl": {"hintBelow": "半"},
    },
}


def _page(model: ProjectModel, table: dict):
    from tools.editor.editors.prop_preset_editor import PropPresetEditor

    model.prop_presets = copy.deepcopy(table)
    model._dirty.clear()
    return PropPresetEditor(model)


def _select(ed, key: str) -> None:
    items = ed._list.findItems(key, Qt.MatchFlag.MatchExactly)
    assert items, key
    ed._list.setCurrentItem(items[0])


def _visit_everything(ed, keys) -> None:
    """把每个预设、每个状态、每块都真建出来走一遍控件（懒建的块没展开过等于没测）。"""
    for key in keys:
        _select(ed, key)
        ed._blowout_block.ensure_built()
        ed._player_block.ensure_built()
        se = ed._states_editor
        se.ensure_built()
        for name in se.state_names():
            se._on_select(name)


@pytest.fixture()
def saved_model(model):
    saved, dirty = model.prop_presets, set(model._dirty)
    yield model
    model.prop_presets = saved
    model._dirty.clear()
    model._dirty.update(dirty)


@pytest.mark.parametrize("which", ["real", "synthetic"])
def test_page_roundtrips_byte_for_byte(saved_model, app, which) -> None:
    m = saved_model
    table = copy.deepcopy(m.prop_presets) if which == "real" else SYNTH_TABLE
    ed = _page(m, table)
    try:
        _visit_everything(ed, list(table))
        assert not ed._dirty, "打开即脏是红线"
        assert _dumps(ed._staged()) == _dumps(table)
    finally:
        ed.deleteLater()


def test_real_data_exercises_blowout() -> None:
    """现网往返只有在数据里真有风吹灭块时才算覆盖到。"""
    data = json.loads((_ROOT / "public/assets/data/prop_presets.json").read_text(encoding="utf-8"))
    assert any(isinstance(e, dict) and isinstance(e.get("blowout"), dict) for e in data.values())


def test_base_blowout_block_edits(saved_model, app) -> None:
    ed = _page(saved_model, {"torch": SYNTH_TABLE["torch"], "plain": SYNTH_TABLE["plain"]})
    try:
        _select(ed, "torch")
        blk = ed._blowout_block
        assert blk._built and blk._on.isChecked(), "配了风吹灭就当场建控件"
        f = blk._form
        assert {f._ember_state.itemData(i) for i in range(f._ember_state.count())} >= {"lit", "guarding", "ember", "out"}
        f._req["windSpeed"].setValue(10)
        out = ed._staged()["torch"]["blowout"]
        assert out["windSpeed"] == 10 and isinstance(out["windSpeed"], int)
        assert list(out) == list(SYNTH_TABLE["torch"]["blowout"]), "键序按磁盘原序、不认识的键透传"
        assert out["drainSeconds"] == 4.0 and isinstance(out["drainSeconds"], float), "没动过的数保原表示"
        assert out["onOutActions"] == SYNTH_TABLE["torch"]["blowout"]["onOutActions"]
        assert ed._dirty
        f._auto.setChecked(False)
        assert ed._staged()["torch"]["blowout"]["auto"] is False
        f._auto.setChecked(True)
        assert ed._staged()["torch"]["blowout"]["auto"] is True, "盘上原本写着 true：勾回去原值保住"
        f._ember_below._on.setChecked(False)
        assert "emberBelow" not in ed._staged()["torch"]["blowout"]
        f._out_state.setCurrentIndex(0)
        assert "outState" not in ed._staged()["torch"]["blowout"], "选「不写」= 删键"
        f._acts["onEmberActions"].set_data([])
        f._acts["onEmberActions"].changed.emit()
        assert ed._staged()["torch"]["blowout"]["onEmberActions"] == []
        blk._on.setChecked(False)
        assert "blowout" not in ed._staged()["torch"], "勾掉「风能吹灭」= 不写键"

        _select(ed, "plain")
        blk = ed._blowout_block
        blk.ensure_built()
        assert not blk._on.isChecked()
        assert "blowout" not in ed._staged()["plain"]
        blk._on.setChecked(True)
        assert ed._staged()["plain"]["blowout"] == {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3}
        f = blk._form
        f._ember_below._on.setChecked(True)
        f._ember_state.setCurrentIndex(f._ember_state.findData("out"))
        f._fade._on.setChecked(True)
        f._acts["onOutActions"].set_data([{"type": "emitNarrativeSignal", "params": {"signal": "火把被风吹灭"}}])
        f._acts["onOutActions"].changed.emit()
        got = ed._staged()["plain"]["blowout"]
        assert got["emberBelow"] == 0.35 and got["emberState"] == "out" and got["fadeMs"] == 500, got
        assert got["onOutActions"][0]["params"]["signal"] == "火把被风吹灭"
    finally:
        ed.deleteLater()


def test_state_blowout_three_modes(saved_model, app) -> None:
    from tools.editor.editors.prop_preset_blocks import (
        STATE_BLOWOUT_INHERIT, STATE_BLOWOUT_NONE, STATE_BLOWOUT_OWN,
    )

    ed = _page(saved_model, {"torch": SYNTH_TABLE["torch"]})
    try:
        _select(ed, "torch")
        se = ed._states_editor
        se.ensure_built()
        field = se._st_blowout
        want = {"lit": STATE_BLOWOUT_INHERIT, "guarding": STATE_BLOWOUT_NONE,
                "ember": STATE_BLOWOUT_OWN, "out": STATE_BLOWOUT_OWN}
        for name, mode in want.items():
            se._on_select(name)
            assert field.mode() == mode, name
            assert field._form.isVisibleTo(field) == (mode == STATE_BLOWOUT_OWN), name
        # ember 自己那块：悬垂 outState 保值展示
        se._on_select("ember")
        combo = field._form._out_state
        assert "状态表里没有" in combo.currentText() and combo.currentData() == "dead"

        se._on_select("lit")
        field._mode.setCurrentIndex(field._mode.findData(STATE_BLOWOUT_NONE))
        assert ed._staged()["torch"]["states"]["lit"] == {"label": "点着", "blowout": None}
        field._mode.setCurrentIndex(field._mode.findData(STATE_BLOWOUT_OWN))
        assert ed._staged()["torch"]["states"]["lit"]["blowout"] == {
            "windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3}
        field._form._req["recoverSeconds"].setValue(1.5)
        assert ed._staged()["torch"]["states"]["lit"]["blowout"]["recoverSeconds"] == 1.5
        field._mode.setCurrentIndex(field._mode.findData(STATE_BLOWOUT_INHERIT))
        assert ed._staged()["torch"]["states"]["lit"] == {"label": "点着"}, "沿用档 = 什么都不写"

        se._on_select("guarding")
        field._mode.setCurrentIndex(field._mode.findData(STATE_BLOWOUT_INHERIT))
        se._on_select("lit")                  # commit-on-leave
        assert "blowout" not in ed._staged()["torch"]["states"]["guarding"]
    finally:
        ed.deleteLater()


def test_state_own_mode_is_not_squeezed_flat(saved_model, app) -> None:
    from tools.editor.editors.prop_preset_blocks import STATE_BLOWOUT_OWN, PropStateBlowoutField

    field = PropStateBlowoutField(saved_model)
    try:
        field.set_data({})
        field.show()
        field._mode.setCurrentIndex(field._mode.findData(STATE_BLOWOUT_OWN))
        field.resize(field.sizeHint())
        QApplication.processEvents()
        assert field._form.height() >= field._form.sizeHint().height() - 1, "切到自己的一块后表单被压扁"
    finally:
        field.deleteLater()


def test_player_control_block_edits(saved_model, app) -> None:
    ed = _page(saved_model, {"torch": SYNTH_TABLE["torch"], "plain": SYNTH_TABLE["plain"]})
    try:
        _select(ed, "plain")
        blk = ed._player_block
        blk.ensure_built()
        assert "playerControl" not in ed._staged()["plain"]
        blk._on.setChecked(True)
        assert ed._staged()["plain"]["playerControl"] == {}, "勾上 = 写对象（全用缺省）"
        combo = blk._states["outState"]
        assert {combo.itemData(i) for i in range(combo.count())} >= {"lit", "out"}
        combo.setCurrentIndex(combo.findData("out"))
        blk._fades["extinguishFadeMs"]._on.setChecked(True)
        assert ed._staged()["plain"]["playerControl"] == {"outState": "out", "extinguishFadeMs": 400}
        blk._on.setChecked(False)
        assert "playerControl" not in ed._staged()["plain"]

        _select(ed, "torch")
        blk = ed._player_block
        assert blk._on.isChecked()
        blk._fades["igniteFadeMs"]._spin.setValue(300)
        assert ed._staged()["torch"]["playerControl"] == {"guardState": "guarding", "igniteFadeMs": 300, "x": [1]}
    finally:
        ed.deleteLater()


def test_hint_below_field_edits(saved_model, app) -> None:
    from PySide6.QtWidgets import QFormLayout

    from tools.editor.editors.prop_preset_blocks import PLAYER_CONTROL_HINT_TIP

    ed = _page(saved_model, {"hinty": SYNTH_TABLE["hinty"], "plain": SYNTH_TABLE["plain"],
                             "hinty_odd": SYNTH_TABLE["hinty_odd"]})
    try:
        _select(ed, "plain")
        blk = ed._player_block
        blk.ensure_built()
        field = blk._hint_below
        form = blk._fields.layout()
        assert isinstance(form, QFormLayout) and form.labelForField(field).text() == "快灭提示线"
        for needle in ("火势掉到这以下火边出快灭符号", "残炭时一直出", "0 = 不提示"):
            assert needle in PLAYER_CONTROL_HINT_TIP and needle in field.toolTip(), needle
        blk._on.setChecked(True)
        assert ed._staged()["plain"]["playerControl"] == {}, "没勾「写」= 不写 hintBelow"
        field._on.setChecked(True)
        assert ed._staged()["plain"]["playerControl"] == {"hintBelow": 0.8}, "勾上按缺省 0.8 写出来"
        field._spin.setValue(0)
        assert ed._staged()["plain"]["playerControl"] == {"hintBelow": 0.0}
        field._on.setChecked(False)
        assert "hintBelow" not in ed._staged()["plain"]["playerControl"]

        _select(ed, "hinty")
        blk = ed._player_block
        assert blk._hint_below._on.isChecked()
        blk._states["litState"].setCurrentIndex(blk._states["litState"].findData("guarding"))
        assert ed._staged()["hinty"]["playerControl"] == {"hintBelow": 0.6, "litState": "guarding"}, \
            "改别的项：hintBelow 原值与键序保住"
        blk._hint_below._spin.setValue(0.3)
        assert ed._staged()["hinty"]["playerControl"]["hintBelow"] == 0.3

        _select(ed, "hinty_odd")
        blk = ed._player_block
        assert blk._hint_below.value() is None, "读不出数：控件显示成没写"
        blk._fades["igniteFadeMs"]._on.setChecked(True)
        assert ed._staged()["hinty_odd"]["playerControl"] == {"hintBelow": "半", "igniteFadeMs": 250}, \
            "读不出数的 hintBelow 没动过就原样留着"
    finally:
        ed.deleteLater()


def test_recover_state_field_edits(saved_model, app) -> None:
    ed = _page(saved_model, {"hinty": SYNTH_TABLE["hinty"], "plain": SYNTH_TABLE["plain"]})
    try:
        _select(ed, "hinty")
        f = ed._blowout_block._form
        combo = f._recover_state
        assert combo.parentWidget().layout().labelForField(combo).text() == "挡风复燃回到"
        assert "不写 = lit" in combo.toolTip() and "挡住风" in combo.toolTip()
        assert combo.itemText(0) == "（不写 = lit）"
        assert {combo.itemData(i) for i in range(combo.count())} >= {"lit", "guarding", "ember", "out"}
        assert combo.currentData() == "guarding"
        combo.setCurrentIndex(combo.findData("ember"))
        out = ed._staged()["hinty"]["blowout"]
        assert out["recoverState"] == "ember" and list(out) == list(SYNTH_TABLE["hinty"]["blowout"])
        combo.setCurrentIndex(0)
        assert "recoverState" not in ed._staged()["hinty"]["blowout"], "选「不写」= 删键"

        # 状态自己那一块：悬垂名字保值展示
        se = ed._states_editor
        se.ensure_built()
        se._on_select("ember")
        sc = se._st_blowout._form._recover_state
        assert sc.currentData() == "ghost" and "状态表里没有" in sc.currentText()

        _select(ed, "plain")
        blk = ed._blowout_block
        blk.ensure_built()
        blk._on.setChecked(True)
        assert "recoverState" not in ed._staged()["plain"]["blowout"], "新配一块不凭空写 recoverState"
        c = blk._form._recover_state
        c.setCurrentIndex(c.findData("lit"))
        assert ed._staged()["plain"]["blowout"]["recoverState"] == "lit"
    finally:
        ed.deleteLater()


def test_state_rename_refreshes_state_name_candidates(saved_model, app) -> None:
    ed = _page(saved_model, {"plain": SYNTH_TABLE["plain"]})
    try:
        _select(ed, "plain")
        blk = ed._player_block
        blk.ensure_built()
        se = ed._states_editor
        se.ensure_built()
        se._states["glow"] = {}
        se._refresh_list(keep="lit")
        se._emit()
        combo = blk._states["litState"]
        assert combo.findData("glow") >= 0, "状态表增了状态，状态名下拉要跟上"
        assert "playerControl" not in ed._staged()["plain"], "换候选不是数据改动"
    finally:
        ed.deleteLater()


def test_block_titles_and_tooltips(saved_model, app) -> None:
    from tools.editor.editors.prop_preset_blocks import BLOWOUT_TIP, PLAYER_CONTROL_TIP

    for needle in ("火势 0..1", "吹熄风速", "残炭", "emitNarrativeSignal", "lockPropState", "setPropState 永远优先",
                   "永远吹不灭"):
        assert needle in BLOWOUT_TIP, needle
    for needle in ("T 点火", "按住 Q 护火", "lockPropState", "快灭提示线"):
        assert needle in PLAYER_CONTROL_TIP, needle
    assert "挡风复燃回到" in BLOWOUT_TIP
    ed = _page(saved_model, {"torch": SYNTH_TABLE["torch"], "plain": SYNTH_TABLE["plain"]})
    try:
        _select(ed, "torch")
        blk = ed._blowout_block
        assert blk._form._hint.text() and "playPropVfx" in blk._form._hint.text()
        blk._form._req["windSpeed"].setValue(0)
        assert "吹不灭" in blk._form._note.text()
        se = ed._states_editor
        se.ensure_built()
        se._on_select("ember")
        se._st_blowout._form._req["windSpeed"].setValue(0)
        assert "沿用基础块" in se._st_blowout._form._note.text()
    finally:
        ed.deleteLater()


def test_save_gate_passes_after_page_flush(saved_model, app) -> None:
    from tools.editor.shared.ref_validator import validate_refs_for_save

    ed = _page(saved_model, {"torch": SYNTH_TABLE["torch"]})
    try:
        _visit_everything(ed, ["torch"])
        ed.flush_to_model(True)
        assert "prop_presets" not in saved_model._dirty, "没改就不许标脏"
        assert validate_refs_for_save(saved_model, dirty={"prop_presets"}) is None
    finally:
        ed.deleteLater()
