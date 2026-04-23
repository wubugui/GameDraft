"""P3-2 默认数据 yaml 完整性 + 节点能消费。"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.io import read_yaml
from tools.chronicle_sim_v3.engine.node import NodeServices
from tools.chronicle_sim_v3.engine.registry import get_node_class
import tools.chronicle_sim_v3.nodes  # noqa: F401


_DATA = Path(__file__).resolve().parents[1] / "data"


def _cook(node_cls, ctx, inputs=None, params=None):
    inst = node_cls()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, NodeServices(), None))


def test_event_types_loadable() -> None:
    d = read_yaml(_DATA / "event_types.yaml")
    assert "event_types" in d
    types = d["event_types"]
    assert len(types) >= 5
    for et in types:
        assert "id" in et and "name" in et
        assert "pick_weight" in et


def test_pacing_loadable() -> None:
    d = read_yaml(_DATA / "pacing.yaml")
    assert "multiplier" in d


def test_rumor_sim_loadable() -> None:
    d = read_yaml(_DATA / "rumor_sim.yaml")
    assert all(k in d for k in ("max_hops", "decay_per_hop", "p_pass"))


def test_style_fingerprints_loadable() -> None:
    d = read_yaml(_DATA / "style_fingerprints.yaml")
    assert "fingerprints" in d
    assert any(f.get("id") == "minguo_chongqing" for f in d["fingerprints"])


def test_presets_rumor_sim() -> None:
    for name in ("default", "aggressive", "conservative"):
        p = _DATA / "presets" / "rumor_sim" / f"{name}.yaml"
        assert p.is_file()
        d = read_yaml(p)
        assert d.get("preset") == name


def test_presets_pacing() -> None:
    for name in ("default", "steady", "wartime"):
        p = _DATA / "presets" / "pacing" / f"{name}.yaml"
        assert p.is_file()
        d = read_yaml(p)
        assert d.get("preset") == name


def test_read_config_event_types_node(tmp_path: Path) -> None:
    """读 event_types 节点能产出非空列表。"""
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.config.event_types"), cs.read_view())
    assert len(out.values["out"]) >= 5


def test_read_config_pacing_default_preset(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.config.pacing"), cs.read_view(),
                 params={"preset": "default"})
    assert out.values["out"].get("multiplier") == 1.0


def test_read_config_pacing_wartime_preset(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.config.pacing"), cs.read_view(),
                 params={"preset": "wartime"})
    windows = out.values["out"].get("windows") or []
    assert len(windows) >= 2


def test_read_config_rumor_sim_preset(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.config.rumor_sim"), cs.read_view(),
                 params={"preset": "aggressive"})
    assert out.values["out"]["p_pass"] == 0.9


def test_eventtype_score_uses_event_type(tmp_path: Path) -> None:
    """把 event_types.yaml 的真实条目灌进 eventtype.score。"""
    types = read_yaml(_DATA / "event_types.yaml")["event_types"]
    pacing = read_yaml(_DATA / "presets" / "pacing" / "default.yaml")
    cs = ContextStore(tmp_path)
    cls = get_node_class("eventtype.score")
    for et in types:
        out = _cook(cls, cs.read_view(),
                     inputs={"et": et, "week": 4, "pacing": pacing})
        assert isinstance(out.values["out"], float)
        assert out.values["out"] >= 0
