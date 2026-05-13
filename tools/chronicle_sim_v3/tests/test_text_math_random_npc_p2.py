"""P2-4 / P2-5 / P2-6：text + math + random + npc 新节点测试。"""
from __future__ import annotations

import asyncio
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
    # text
    "text.head", "text.format", "json.path",
    # math/random
    "math.eval",
    "random.bernoulli", "random.weighted_sample", "random.shuffle", "random.choice",
    # npc
    "npc.location_resolve", "npc.context_compose",
}


def test_all_p2_node_kinds_registered() -> None:
    assert _NEW_KINDS.issubset(set(list_kinds()))


# ---------- text ----------


def test_text_head(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("text.head")
    out = _cook(cls, cs.read_view(), inputs={"text": "你好世界"}, params={"n": 3})
    assert out.values["out"] == "你好世"


def test_text_format(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("text.format")
    out = _cook(cls, cs.read_view(),
                 inputs={"vars": {"a": 1, "name": "卷"}},
                 params={"pattern": "{name}={a}"})
    assert out.values["out"] == "卷=1"


def test_text_format_missing_var(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("text.format")
    with pytest.raises(NodeBusinessError):
        _cook(cls, cs.read_view(), inputs={"vars": {}},
              params={"pattern": "{missing}"})


def test_json_path_simple(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("json.path")
    out = _cook(cls, cs.read_view(),
                 inputs={"value": {"a": {"b": [10, 20, 30]}}},
                 params={"path": "a.b[1]"})
    assert out.values["out"] == 20


def test_json_path_missing_returns_null(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("json.path")
    out = _cook(cls, cs.read_view(),
                 inputs={"value": {"a": {}}},
                 params={"path": "a.b.c"})
    assert out.values["out"] is None


def test_json_path_nested_array(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("json.path")
    out = _cook(cls, cs.read_view(),
                 inputs={"value": {"x": [[1], [2, 3]]}},
                 params={"path": "x[1][0]"})
    assert out.values["out"] == 2


# ---------- math.eval ----------


def test_math_eval(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("math.eval")
    out = _cook(cls, cs.read_view(),
                 inputs={"vars": {"x": 3, "y": 4}},
                 params={"expr": "${inputs.x * inputs.y}"})
    assert out.values["out"] == 12


# ---------- random.* ----------


def test_random_bernoulli_deterministic(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.bernoulli")
    a = _cook(cls, cs.read_view(), inputs={"seed": 12345}, params={"p": 0.5})
    b = _cook(cls, cs.read_view(), inputs={"seed": 12345}, params={"p": 0.5})
    assert a.values["out"] == b.values["out"]


def test_random_bernoulli_p_extremes(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.bernoulli")
    assert _cook(cls, cs.read_view(), inputs={"seed": 1},
                  params={"p": 1.0}).values["out"] is True
    assert _cook(cls, cs.read_view(), inputs={"seed": 1},
                  params={"p": 0.0}).values["out"] is False
    with pytest.raises(NodeBusinessError):
        _cook(cls, cs.read_view(), inputs={"seed": 1}, params={"p": 1.5})


def test_random_weighted_sample_no_replace(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.weighted_sample")
    items = [{"id": "a", "weight": 1}, {"id": "b", "weight": 1}, {"id": "c", "weight": 100}]
    out = _cook(cls, cs.read_view(),
                 inputs={"seed": 42, "items_with_weights": items},
                 params={"k": 2, "replace": False})
    ids = [it["id"] for it in out.values["out"]]
    # 不放回，结果各项唯一
    assert len(set(ids)) == 2


def test_random_weighted_sample_replace(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.weighted_sample")
    items = [{"id": "a", "weight": 1}, {"id": "b", "weight": 99}]
    out = _cook(cls, cs.read_view(),
                 inputs={"seed": 1, "items_with_weights": items},
                 params={"k": 5, "replace": True})
    assert len(out.values["out"]) == 5


def test_random_shuffle_deterministic(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.shuffle")
    a = _cook(cls, cs.read_view(), inputs={"seed": 7, "list": [1, 2, 3, 4, 5]})
    b = _cook(cls, cs.read_view(), inputs={"seed": 7, "list": [1, 2, 3, 4, 5]})
    assert a.values["out"] == b.values["out"]
    assert sorted(a.values["out"]) == [1, 2, 3, 4, 5]


def test_random_choice_empty_raises(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.choice")
    with pytest.raises(NodeBusinessError):
        _cook(cls, cs.read_view(), inputs={"seed": 1, "list": []})


def test_random_choice_works(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("random.choice")
    out = _cook(cls, cs.read_view(), inputs={"seed": 1, "list": ["a", "b"]})
    assert out.values["out"] in ("a", "b")


# ---------- npc.* ----------


def test_npc_location_resolve_id_match(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.location_resolve")
    out = _cook(cls, cs.read_view(),
                 inputs={
                     "agent": {"current_location": "loc_main"},
                     "locations": [{"id": "loc_main", "name": "主城"}],
                 })
    assert out.values["loc_id"] == "loc_main"


def test_npc_location_resolve_name_match(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.location_resolve")
    out = _cook(cls, cs.read_view(),
                 inputs={
                     "agent": {"location_hint": "朝天门"},
                     "locations": [{"id": "loc_x", "name": "朝天门客栈"}],
                 })
    assert out.values["loc_id"] == "loc_x"


def test_npc_location_resolve_unmatched(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.location_resolve")
    out = _cook(cls, cs.read_view(),
                 inputs={
                     "agent": {"current_location": "nope"},
                     "locations": [{"id": "loc_a", "name": "甲"}],
                 })
    assert out.values["loc_id"] == ""


def test_npc_context_compose_headed(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.context_compose")
    out = _cook(cls, cs.read_view(),
                 inputs={"parts": {"角色": "张三", "地点": "城北"}},
                 params={"format": "headed"})
    assert "## 角色" in out.values["out"]
    assert "## 地点" in out.values["out"]


def test_npc_context_compose_xml(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.context_compose")
    out = _cook(cls, cs.read_view(),
                 inputs={"parts": {"a": "x"}},
                 params={"format": "xml"})
    assert "<a>" in out.values["out"]
    assert "</a>" in out.values["out"]
