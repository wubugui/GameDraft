"""私有信号（signals[].scope）在 Python 两处兜底校验里的护栏 + 与 TS 权威的文案对账。

权威在 `src/core/narrativeGraphValidation.ts` 的 `validatePrivateSignalListeners` /
`signal.scope.invalid`；Python 兜底（叙事编辑器保存路径 + validate-data）必须**同码同文案
且是子集**。这里既验行为，也把三条文案与 TS 源码逐字对账——注释里写"对齐了"不算护栏。
"""
from __future__ import annotations

import json
from pathlib import Path

from tools.editor.editors.narrative_state_editor import validate_narrative_graphs


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _ts_source() -> str:
    return (_repo_root() / "src/core/narrativeGraphValidation.ts").read_text(encoding="utf-8")


def _file(signals: list[dict], compositions: list[dict]) -> dict:
    return {"schemaVersion": 3, "signals": signals, "compositions": compositions}


def _wrapper_comp(
    comp_id: str, graph_id: str, signal: str, *, owner_type: str = "hotspot", owner_id: str = "chest_1",
) -> dict:
    """owner 绑定的 wrapper：私有信号的合法监听方。"""
    return {
        "id": comp_id,
        "mainGraph": {
            "id": f"{graph_id}_flow", "ownerType": "flow", "ownerId": comp_id,
            "initialState": "idle", "states": {"idle": {"id": "idle"}}, "transitions": [],
        },
        "elements": [{
            "id": f"el_{graph_id}", "kind": "wrapperGraph",
            "ownerType": owner_type, "ownerId": owner_id,
            "graph": {
                "id": graph_id, "ownerType": owner_type, "ownerId": owner_id,
                "initialState": "closed",
                "states": {"closed": {"id": "closed"}, "opened": {"id": "opened"}},
                "transitions": [{"id": "t1", "from": "closed", "to": "opened", "signal": signal}],
            },
        }],
    }


def _flow_comp(comp_id: str, graph_id: str, signal: str) -> dict:
    """无 owner 绑定的主线 flow：监听私有信号 = 死监听。"""
    return {
        "id": comp_id,
        "mainGraph": {
            "id": graph_id, "initialState": "a",
            "states": {"a": {"id": "a"}, "b": {"id": "b"}},
            "transitions": [{"id": "t_main", "from": "a", "to": "b", "signal": signal}],
        },
        "elements": [],
    }


def _codes(issues: list[dict]) -> list[str]:
    return [i["code"] for i in issues]


# --------------------------------------------------------------------------- #
# 叙事编辑器保存路径兜底（validate_narrative_graphs）
# --------------------------------------------------------------------------- #
def test_scope_must_be_global_or_private() -> None:
    issues = validate_narrative_graphs(_file(
        [{"id": "sig_bad", "scope": "local"}],
        [_wrapper_comp("c1", "g1", "sig_bad")],
    ))
    bad = [i for i in issues if i["code"] == "signal.scope.invalid"]
    assert len(bad) == 1, _codes(issues)
    assert bad[0]["severity"] == "error"
    assert bad[0]["message"] == "sig_bad: signal scope must be 'global' or 'private'"
    assert bad[0]["path"] == "signals[0].scope"


def test_scope_absent_or_valid_is_silent() -> None:
    for signals in (
        [{"id": "s"}],
        [{"id": "s", "scope": "global"}],
        [{"id": "s", "scope": None}],  # 显式 null 与缺键同义：兜底不得比 TS 严
    ):
        issues = validate_narrative_graphs(_file(signals, [_wrapper_comp("c1", "g1", "s")]))
        assert "signal.scope.invalid" not in _codes(issues), signals


def test_private_listener_on_unbound_graph_is_error() -> None:
    issues = validate_narrative_graphs(_file(
        [{"id": "chest_opened", "scope": "private"}],
        [_flow_comp("c_main", "flow_main", "chest_opened")],
    ))
    bad = [i for i in issues if i["code"] == "signal.private.listener.unbound"]
    assert len(bad) == 1, _codes(issues)
    assert bad[0]["severity"] == "error"
    assert bad[0]["message"] == (
        'flow_main: 无 owner 绑定的图不能监听私有信号 "chest_opened"'
        "（私有信号只投递给发射方 owner 的 wrapper 图，这条监听永远不会触发）"
    )
    assert bad[0]["path"] == "flow_main.transitions.t_main"
    # 有人听着，就不该再报"没人听"
    assert "signal.private.unlistened" not in _codes(issues)


def test_private_listener_on_owner_bound_wrapper_is_clean() -> None:
    issues = validate_narrative_graphs(_file(
        [{"id": "chest_opened", "scope": "private"}],
        [_wrapper_comp("c1", "chest_1_state", "chest_opened")],
    ))
    assert "signal.private.listener.unbound" not in _codes(issues)
    assert "signal.private.unlistened" not in _codes(issues)


def test_private_signal_without_listener_is_warning() -> None:
    issues = validate_narrative_graphs(_file(
        [{"id": "chest_opened", "scope": "private"}],
        [_wrapper_comp("c1", "g1", "other_signal")],
    ))
    bad = [i for i in issues if i["code"] == "signal.private.unlistened"]
    assert len(bad) == 1, _codes(issues)
    assert bad[0]["severity"] == "warning"
    assert bad[0]["message"] == '私有信号 "chest_opened" 没有任何 wrapper 图监听（发射它不会推动任何状态）'


def test_global_signal_listened_by_flow_stays_clean() -> None:
    """全局信号被主线监听是天经地义的：三条检查一条都不该响。"""
    issues = validate_narrative_graphs(_file(
        [{"id": "open_all", "scope": "global"}],
        [_flow_comp("c_main", "flow_main", "open_all")],
    ))
    for code in ("signal.scope.invalid", "signal.private.listener.unbound", "signal.private.unlistened"):
        assert code not in _codes(issues)


def test_reactive_transition_is_not_a_private_listener() -> None:
    """reactive 迁移的 signal 字段只是占位、运行时不读——不能据它判监听（TS 同口径）。"""
    comp = _flow_comp("c_main", "flow_main", "chest_opened")
    comp["mainGraph"]["transitions"][0]["trigger"] = "reactive"
    issues = validate_narrative_graphs(_file([{"id": "chest_opened", "scope": "private"}], [comp]))
    assert "signal.private.listener.unbound" not in _codes(issues)
    assert "signal.private.unlistened" in _codes(issues)


# --------------------------------------------------------------------------- #
# validate-data 兜底（tools/editor/validator.py）
# --------------------------------------------------------------------------- #
def _validator_issues(data: dict) -> list:
    from tools.editor.validator import _validate_private_signal_listeners

    issues: list = []
    _validate_private_signal_listeners(data, issues)
    return issues


def test_validator_backstop_matches_editor_backstop() -> None:
    unbound = _file(
        [{"id": "chest_opened", "scope": "private"}],
        [_flow_comp("c_main", "flow_main", "chest_opened")],
    )
    rows = _validator_issues(unbound)
    assert [r.severity for r in rows] == ["error"]
    assert rows[0].message == (
        'flow_main: 无 owner 绑定的图不能监听私有信号 "chest_opened"'
        "（私有信号只投递给发射方 owner 的 wrapper 图，这条监听永远不会触发）"
    )

    unlistened = _file([{"id": "chest_opened", "scope": "private"}], [])
    rows = _validator_issues(unlistened)
    assert [r.severity for r in rows] == ["warning"]
    assert rows[0].message == '私有信号 "chest_opened" 没有任何 wrapper 图监听（发射它不会推动任何状态）'

    ok = _file(
        [{"id": "chest_opened", "scope": "private"}],
        [_wrapper_comp("c1", "chest_1_state", "chest_opened")],
    )
    assert _validator_issues(ok) == []


def test_validator_scope_check_reaches_full_narrative_pass(tmp_path) -> None:
    """从 `_validate_narrative` 这一层进（而不是只测内部函数）：坏 scope 真会被报出来。"""
    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project
    from tools.editor.validator import _validate_narrative

    root = tmp_path / "proj"
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    model.narrative_graphs = _file(
        [{"id": "sig_bad", "scope": "weird"}, {"id": "chest_opened", "scope": "private"}],
        [_flow_comp("c_main", "flow_main", "chest_opened")],
    )
    issues: list = []
    _validate_narrative(model, issues)
    messages = [i.message for i in issues]
    assert "sig_bad: signal scope must be 'global' or 'private'" in messages
    assert any("无 owner 绑定的图不能监听私有信号" in m for m in messages)


# --------------------------------------------------------------------------- #
# 与 TS 权威的文案对账（镜像清单配对账，norms 不变量 8）
# --------------------------------------------------------------------------- #
def test_codes_and_messages_are_verbatim_from_ts_authority() -> None:
    ts = _ts_source()
    for code in ("signal.scope.invalid", "signal.private.listener.unbound", "signal.private.unlistened"):
        assert f"'{code}'" in ts, f"TS 权威里找不到 {code}——两边已经漂了"
    assert "signal scope must be 'global' or 'private'" in ts
    assert "无 owner 绑定的图不能监听私有信号" in ts
    assert "（私有信号只投递给发射方 owner 的 wrapper 图，这条监听永远不会触发）" in ts
    assert "没有任何 wrapper 图监听（发射它不会推动任何状态）" in ts


def test_python_backstop_is_a_subset_of_ts_codes() -> None:
    """兜底只许更松：Python 报的私有信号相关 code 必须都能在 TS 权威里找到。"""
    ts = _ts_source()
    data = _file(
        [{"id": "a", "scope": "private"}, {"id": "b", "scope": "nope"}],
        [_flow_comp("c_main", "flow_main", "a")],
    )
    for code in {c for c in _codes(validate_narrative_graphs(data)) if c.startswith("signal.")}:
        assert f"'{code}'" in ts, f"Python 兜底报了 TS 没有的 {code}"


def test_live_project_data_has_no_new_private_signal_issues() -> None:
    """现网数据一条私有信号都还没有：这三条检查对既有 validate-data 计数必须零影响。"""
    data = json.loads(
        (_repo_root() / "public/assets/data/narrative_graphs.json").read_text(encoding="utf-8"),
    )
    assert not [s for s in data.get("signals") or [] if isinstance(s, dict) and s.get("scope")]
    assert _validator_issues(data) == []
