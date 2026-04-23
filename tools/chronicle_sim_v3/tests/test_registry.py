"""节点注册表与 P1 节点单测。"""
from __future__ import annotations

import asyncio

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    NodeServices,
)
from tools.chronicle_sim_v3.engine.registry import (
    all_specs,
    get_node_class,
    list_kinds,
    register_node,
)
from tools.chronicle_sim_v3.engine.types import PortSpec
import tools.chronicle_sim_v3.nodes  # noqa: F401  触发注册


_P1_KINDS = {
    "read.world.setting",
    "read.world.agents",
    "read.chronicle.events",
    "filter.where",
    "map.expr",
    "sort.by",
    "take.n",
    "count",
    "list.concat",
    "dict.merge",
    "template.render",
    "text.concat",
    "json.encode",
    "json.decode",
    "math.compare",
    "math.range",
    "rng.from_seed",
    "npc.filter_active",
    "npc.partition_by_tier",
}


def _cook_sync(node_cls, ctx, inputs=None, params=None, services=None):
    inst = node_cls()
    services = services or NodeServices()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, services, None))


def test_p1_kinds_registered() -> None:
    registered = set(list_kinds())
    missing = _P1_KINDS - registered
    assert not missing, f"未注册：{missing}"


def test_get_node_class_unknown() -> None:
    with pytest.raises(ValidationError):
        get_node_class("totally.unknown")


def test_register_duplicate_rejected() -> None:
    """重复注册 same kind by 不同 class 应报错。"""

    @register_node
    class _A:
        spec = NodeKindSpec(
            kind="test.dup_only", category="t", title="x", description="x",
            inputs=(), outputs=(PortSpec(name="o", type="Any"),),
        )

    with pytest.raises(ValidationError):
        @register_node
        class _B:
            spec = NodeKindSpec(
                kind="test.dup_only", category="t", title="y", description="y",
                inputs=(), outputs=(PortSpec(name="o", type="Any"),),
            )


def test_register_missing_spec_rejected() -> None:
    with pytest.raises(ValidationError):
        @register_node
        class NoSpec:
            pass


def test_all_specs_returns_objects() -> None:
    specs = all_specs()
    assert all(isinstance(s, NodeKindSpec) for s in specs)
    kinds = {s.kind for s in specs}
    assert _P1_KINDS.issubset(kinds)


# ---------- P1 节点单测 ----------


def test_read_world_agents(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    (tmp_path / "world" / "agents").mkdir(parents=True)
    import json as _json

    (tmp_path / "world" / "agents" / "a.json").write_text(
        _json.dumps({"id": "a", "life_status": "alive"})
    )
    cls = get_node_class("read.world.agents")
    out = _cook_sync(cls, cs.read_view())
    assert len(out.values["out"]) == 1


def test_read_chronicle_events(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    import json as _json

    d = tmp_path / "chronicle" / "week_005" / "events"
    d.mkdir(parents=True)
    (d / "x.json").write_text(_json.dumps({"id": "x"}))
    cls = get_node_class("read.chronicle.events")
    out = _cook_sync(cls, cs.read_view(), inputs={"week": 5})
    assert out.values["out"] == [{"id": "x"}]


def test_filter_where(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("filter.where")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"list": [{"v": 1}, {"v": 2}, {"v": 3}]},
        params={"expr": "${item.v > 1}"},
    )
    assert [it["v"] for it in out.values["out"]] == [2, 3]


def test_map_expr(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("map.expr")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"list": [{"v": 1}, {"v": 2}]},
        params={"expr": "${item.v * 10}"},
    )
    assert out.values["out"] == [10, 20]


def test_sort_by_asc_desc(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("sort.by")
    out_a = _cook_sync(
        cls, cs.read_view(),
        inputs={"list": [{"v": 3}, {"v": 1}, {"v": 2}]},
        params={"key_expr": "${item.v}", "order": "asc"},
    )
    out_d = _cook_sync(
        cls, cs.read_view(),
        inputs={"list": [{"v": 3}, {"v": 1}, {"v": 2}]},
        params={"key_expr": "${item.v}", "order": "desc"},
    )
    assert [it["v"] for it in out_a.values["out"]] == [1, 2, 3]
    assert [it["v"] for it in out_d.values["out"]] == [3, 2, 1]


def test_take_n(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("take.n")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"list": [1, 2, 3, 4]},
        params={"n": 2},
    )
    assert out.values["out"] == [1, 2]


def test_take_n_negative_rejected(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("take.n")
    with pytest.raises(NodeBusinessError):
        _cook_sync(cls, cs.read_view(), inputs={"list": [1, 2]}, params={"n": -1})


def test_count(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("count")
    out = _cook_sync(cls, cs.read_view(), inputs={"list": [1, 2, 3]})
    assert out.values["out"] == 3


def test_list_concat(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("list.concat")
    out = _cook_sync(cls, cs.read_view(), inputs={"lists": [[1, 2], [3, 4]]})
    assert out.values["out"] == [1, 2, 3, 4]


def test_dict_merge_replace(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("dict.merge")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"dicts": [{"a": 1, "b": 2}, {"b": 99}]},
        params={"strategy": "replace"},
    )
    assert out.values["out"] == {"a": 1, "b": 99}


def test_dict_merge_deep(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("dict.merge")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"dicts": [{"x": {"a": 1, "b": 2}}, {"x": {"b": 99, "c": 3}}]},
        params={"strategy": "deep"},
    )
    assert out.values["out"] == {"x": {"a": 1, "b": 99, "c": 3}}


def test_template_render(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("template.render")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"vars": {"name": "卷帘", "n": 3}},
        params={"template": "Hello {{name}}, {{n}} 次"},
    )
    assert out.values["out"] == "Hello 卷帘, 3 次"


def test_template_render_missing(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("template.render")
    with pytest.raises(NodeBusinessError):
        _cook_sync(
            cls, cs.read_view(),
            inputs={"vars": {"a": 1}},
            params={"template": "{{missing}}"},
        )


def test_text_concat(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("text.concat")
    out = _cook_sync(
        cls, cs.read_view(),
        inputs={"parts": ["a", "b", "c"]},
        params={"sep": "-"},
    )
    assert out.values["out"] == "a-b-c"


def test_json_encode_decode_roundtrip(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    enc = get_node_class("json.encode")
    dec = get_node_class("json.decode")
    e = _cook_sync(enc, cs.read_view(), inputs={"value": {"x": [1, 2]}})
    d = _cook_sync(dec, cs.read_view(), inputs={"text": e.values["out"]})
    assert d.values["out"] == {"x": [1, 2]}


def test_math_compare(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("math.compare")
    assert _cook_sync(cls, cs.read_view(), inputs={"a": 1, "b": 2},
                      params={"op": "<"}).values["out"] is True
    assert _cook_sync(cls, cs.read_view(), inputs={"a": "x", "b": "x"},
                      params={"op": "=="}).values["out"] is True


def test_math_range(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("math.range")
    out = _cook_sync(cls, cs.read_view(),
                     params={"start": 0, "end": 5, "step": 2})
    assert out.values["out"] == [0, 2, 4]


def test_rng_from_seed_deterministic(tmp_path) -> None:
    cs = ContextStore(tmp_path, run_id="run_xyz")
    cls = get_node_class("rng.from_seed")
    s1 = _cook_sync(cls, cs.read_view(), params={"key": "k1"}).values["seed"]
    s2 = _cook_sync(cls, cs.read_view(), params={"key": "k1"}).values["seed"]
    s3 = _cook_sync(cls, cs.read_view(), params={"key": "k2"}).values["seed"]
    assert s1 == s2
    assert s1 != s3


def test_npc_filter_active(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.filter_active")
    agents = [
        {"id": "a", "life_status": "alive"},
        {"id": "b", "life_status": "dead"},
        {"id": "c"},  # 缺字段视为 alive
    ]
    out = _cook_sync(cls, cs.read_view(), inputs={"agents": agents})
    ids = {a["id"] for a in out.values["out"]}
    assert ids == {"a", "c"}


def test_npc_partition_by_tier(tmp_path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("npc.partition_by_tier")
    agents = [
        {"id": "a", "tier": "S"},
        {"id": "b", "tier": "A"},
        {"id": "c", "tier": "B"},
        {"id": "d", "tier": "C"},
        {"id": "e"},  # 缺 tier → C
    ]
    out = _cook_sync(cls, cs.read_view(), inputs={"agents": agents})
    assert {a["id"] for a in out.values["S"]} == {"a"}
    assert {a["id"] for a in out.values["A"]} == {"b"}
    assert {a["id"] for a in out.values["B"]} == {"c"}
    assert {a["id"] for a in out.values["C"]} == {"d", "e"}
