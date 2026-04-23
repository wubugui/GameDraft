"""P2-7 event + eventtype + pacing 节点测试。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.node import NodeBusinessError, NodeServices
from tools.chronicle_sim_v3.engine.registry import get_node_class, list_kinds
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _cook(node_cls, ctx, inputs=None, params=None):
    inst = node_cls()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, NodeServices(), None))


_NEW_KINDS = {
    "event.actors_union", "event.visible_to", "event.filter_visible",
    "event.normalize_for_rumors", "event.public_digest_line",
    "eventtype.condition_pass", "eventtype.cooldown_pass",
    "eventtype.score", "eventtype.format_for_prompt",
    "pacing.multiplier",
}


def test_all_kinds_registered() -> None:
    assert _NEW_KINDS.issubset(set(list_kinds()))


# ---------- event ----------


def test_event_actors_union(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("event.actors_union")
    out = _cook(cls, cs.read_view(),
                 inputs={"event": {
                     "actor": "a", "related": ["b", "c"],
                     "witness": ["c", "d"],
                 }})
    assert sorted(out.values["out"]) == ["a", "b", "c", "d"]


def test_event_visible_to(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("event.visible_to")
    e = {"actor": "a", "witness": ["b"]}
    assert _cook(cls, cs.read_view(),
                  inputs={"event": e, "agent_id": "b"}).values["out"] is True
    assert _cook(cls, cs.read_view(),
                  inputs={"event": e, "agent_id": "z"}).values["out"] is False


def test_event_filter_visible(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("event.filter_visible")
    events = [
        {"id": "1", "actor": "a"},
        {"id": "2", "actor": "b", "witness": ["a"]},
        {"id": "3", "actor": "x"},
    ]
    out = _cook(cls, cs.read_view(),
                 inputs={"events": events, "agent_id": "a"})
    assert [e["id"] for e in out.values["out"]] == ["1", "2"]


def test_event_normalize_for_rumors(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("event.normalize_for_rumors")
    e = {"id": "1", "actor": "a", "related": ["b", ""], "tier_b_group": "g1"}
    out = _cook(cls, cs.read_view(), inputs={"event": e})
    out_e = out.values["out"]
    # 'group:g1' 应被滤掉
    assert "group:g1" not in out_e["related"]
    assert "" not in out_e["related"]
    assert "spread" in out_e


def test_event_public_digest_line_present(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("event.public_digest_line")
    e = {"truth": {"who_knows_what": {"公开": "城内传出消息"}}}
    out = _cook(cls, cs.read_view(), inputs={"event": e})
    assert out.values["out"] == "城内传出消息"


def test_event_public_digest_line_absent(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("event.public_digest_line")
    out = _cook(cls, cs.read_view(),
                 inputs={"event": {"truth": {"who_knows_what": {"内部": "x"}}}})
    assert out.values["out"] is None


# ---------- eventtype ----------


def test_eventtype_condition_pass_all_true(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.condition_pass")
    et = {"conditions": ["${ctx.week >= 1}", "${ctx.week < 100}"]}
    out = _cook(cls, cs.read_view(), inputs={"et": et, "week": 5})
    assert out.values["out"] is True


def test_eventtype_condition_pass_one_false(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.condition_pass")
    et = {"conditions": ["${ctx.week >= 100}"]}
    out = _cook(cls, cs.read_view(), inputs={"et": et, "week": 1})
    assert out.values["out"] is False


def test_eventtype_condition_pass_empty_passes(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.condition_pass")
    out = _cook(cls, cs.read_view(),
                 inputs={"et": {"conditions": []}, "week": 1})
    assert out.values["out"] is True


def test_eventtype_cooldown_pass_no_cd(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.cooldown_pass")
    out = _cook(cls, cs.read_view(),
                 inputs={"et": {"id": "x"}, "week": 1})
    assert out.values["out"] is True


def test_eventtype_cooldown_pass_with_history(tmp_path: Path) -> None:
    """若 week=2 出现过 type=x，cooldown=3，week_now=4 → 距 2 周 ≤3 → false。"""
    d = tmp_path / "chronicle" / "week_002" / "events"
    d.mkdir(parents=True)
    (d / "e1.json").write_text(json.dumps({"id": "e1", "type_id": "x"}))
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.cooldown_pass")
    out = _cook(cls, cs.read_view(),
                 inputs={"et": {"id": "x", "cooldown_weeks": 3}, "week": 4})
    assert out.values["out"] is False


def test_eventtype_score(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.score")
    et = {"pick_weight": 2.0, "period": 4}
    pacing = {"multiplier": 1.5}
    # week=4 % 4 == 0 → period_factor 1.5
    out = _cook(cls, cs.read_view(),
                 inputs={"et": et, "week": 4, "pacing": pacing})
    assert out.values["out"] == pytest.approx(2.0 * 1.5 * 1.5)


def test_eventtype_format_for_prompt(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.format_for_prompt")
    out = _cook(cls, cs.read_view(),
                 inputs={"types": [
                     {"id": "a", "name": "甲", "description": "事件 A"},
                     {"id": "b", "name": "乙", "tags": ["t1"], "summary": "事件 B"},
                 ]})
    assert "甲" in out.values["out"]
    assert "[t1]" in out.values["out"]


# ---------- pacing ----------


def test_pacing_multiplier_default(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("pacing.multiplier")
    out = _cook(cls, cs.read_view(), inputs={"week": 5, "pacing": {}})
    assert out.values["out"] == 1.0


def test_pacing_multiplier_window_hit(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("pacing.multiplier")
    pacing = {"windows": [{"from": 1, "to": 4, "multiplier": 0.5}]}
    out = _cook(cls, cs.read_view(), inputs={"week": 3, "pacing": pacing})
    assert out.values["out"] == 0.5


def test_pacing_multiplier_global_fallback(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("pacing.multiplier")
    out = _cook(cls, cs.read_view(),
                 inputs={"week": 100, "pacing": {"multiplier": 2.5}})
    assert out.values["out"] == 2.5
