"""SubgraphLoader / PresetLoader 加载测试。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.expr import PresetRef, SubgraphRef
from tools.chronicle_sim_v3.engine.subgraph import (
    PresetLoader,
    SubgraphLoader,
)


def _write_subgraph(path: Path, name: str, content: str) -> None:
    p = path / "data" / "subgraphs" / f"{name}.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(content), encoding="utf-8")


def _write_preset(path: Path, topic: str, name: str, content: str) -> None:
    p = path / "data" / "presets" / topic / f"{name}.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(content), encoding="utf-8")


def test_subgraph_loader_finds_in_search_root(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "x", """\
        schema: g@1
        id: x
        spec:
          nodes:
            n: {kind: read.world.agents}
    """)
    loader = SubgraphLoader(tmp_path)
    spec = loader.load(SubgraphRef(name="x"))
    assert spec.id == "x"


def test_subgraph_loader_falls_back_to_pkg_root() -> None:
    """没有 search_root 的子图查询应能落到 v3 包内 data/graphs/p1_smoke.yaml。"""
    loader = SubgraphLoader()
    # p1_smoke 在 v3 包 data/graphs/ 下
    spec = loader.load(SubgraphRef(name="p1_smoke"))
    assert spec.id == "p1_smoke"


def test_subgraph_loader_missing_raises(tmp_path: Path) -> None:
    loader = SubgraphLoader(tmp_path)
    with pytest.raises(ValidationError, match="未找到子图"):
        loader.load(SubgraphRef(name="nonexistent_xxx"))


def test_preset_loader_finds(tmp_path: Path) -> None:
    _write_preset(tmp_path, "rumor_sim", "default", "k: 1\n")
    loader = PresetLoader(tmp_path)
    d = loader.load(PresetRef(topic="rumor_sim", name="default"))
    assert d == {"k": 1}


def test_preset_loader_missing_raises(tmp_path: Path) -> None:
    loader = PresetLoader(tmp_path)
    with pytest.raises(ValidationError, match="未找到 preset"):
        loader.load(PresetRef(topic="nope", name="x"))
