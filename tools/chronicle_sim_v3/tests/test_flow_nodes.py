"""flow 抽屉测试：foreach / fanout / parallel / when / switch / merge / subgraph / barrier。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.graph import GraphLoader
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _write_subgraph(rd: Path, name: str, content: str) -> None:
    p = rd / "data" / "subgraphs" / f"{name}.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(content), encoding="utf-8")


@pytest.mark.asyncio
async def test_flow_foreach_real_use(tmp_path: Path) -> None:
    """更现实：item 是 list，body 数其长度。"""
    _write_subgraph(tmp_path, "len_body", """\
        schema: g@1
        id: len_body
        spec:
          nodes:
            cnt:
              kind: count
              in:
                list: ${item}
          result:
            n: ${nodes.cnt.out}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            f:
              kind: flow.foreach
              in:
                over:
                  - [1, 2, 3]
                  - [4, 5]
                  - []
              params:
                body: ${subgraph:len_body}
          result:
            collected: ${nodes.f.collected}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.status == "completed"
    assert [r["n"] for r in res.outputs["collected"]] == [3, 2, 0]


@pytest.mark.asyncio
async def test_flow_when_true_runs_body(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "always_one", """\
        schema: g@1
        id: always_one
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 0, end: 1}
          result:
            v: ${nodes.r.out}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            w:
              kind: flow.when
              in:
                condition: true
              params:
                body: ${subgraph:always_one}
          result:
            t: ${nodes.w.triggered}
            o: ${nodes.w.out}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.outputs["t"] is True
    assert res.outputs["o"] == {"v": [0]}


@pytest.mark.asyncio
async def test_flow_when_false_skips_body(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "x", """\
        schema: g@1
        id: x
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 0, end: 1}
          result:
            v: ${nodes.r.out}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            w:
              kind: flow.when
              in:
                condition: false
              params:
                body: ${subgraph:x}
          result:
            t: ${nodes.w.triggered}
            o: ${nodes.w.out}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.outputs["t"] is False
    assert res.outputs["o"] is None


@pytest.mark.asyncio
async def test_flow_subgraph_inputs_passthrough(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "echo", """\
        schema: g@1
        id: echo
        spec:
          nodes:
            r: {kind: math.range, params: {start: 0, end: 2}}
          result:
            seq: ${nodes.r.out}
            from_input: ${inputs.x}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            s:
              kind: flow.subgraph
              params:
                ref: ${subgraph:echo}
                inputs: {x: 99}
          result:
            o: ${nodes.s.out}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.outputs["o"]["from_input"] == 99
    assert res.outputs["o"]["seq"] == [0, 1]


@pytest.mark.asyncio
async def test_flow_switch_default(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "case_a", """\
        schema: g@1
        id: case_a
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 1, end: 2}
          result:
            v: ${nodes.r.out}
    """)
    _write_subgraph(tmp_path, "case_default", """\
        schema: g@1
        id: case_default
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 9, end: 10}
          result:
            v: ${nodes.r.out}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            s:
              kind: flow.switch
              in:
                selector: "B"
              params:
                cases:
                  A: ${subgraph:case_a}
                  _default: ${subgraph:case_default}
          result:
            o: ${nodes.s.out}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.outputs["o"]["v"] == [9]


@pytest.mark.asyncio
async def test_flow_parallel_collects_outputs(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "p1", """\
        schema: g@1
        id: p1
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 0, end: 1}
          result:
            v: ${nodes.r.out}
    """)
    _write_subgraph(tmp_path, "p2", """\
        schema: g@1
        id: p2
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 5, end: 7}
          result:
            v: ${nodes.r.out}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            p:
              kind: flow.parallel
              params:
                children:
                  a: ${subgraph:p1}
                  b: ${subgraph:p2}
          result:
            o: ${nodes.p.outputs}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.outputs["o"]["a"]["v"] == [0]
    assert res.outputs["o"]["b"]["v"] == [5, 6]


@pytest.mark.asyncio
async def test_flow_barrier(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "noop", """\
        schema: g@1
        id: noop
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 0, end: 0}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            b:
              kind: flow.barrier
              params:
                children:
                  - ${subgraph:noop}
                  - ${subgraph:noop}
          result:
            done: ${nodes.b.done}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert res.outputs["done"] is True


@pytest.mark.asyncio
async def test_flow_foreach_with_state_accumulates(tmp_path: Path) -> None:
    """body 接受 ${inputs.state} 与 ${item}，输出含新 state。"""
    _write_subgraph(tmp_path, "acc", """\
        schema: g@1
        id: acc
        spec:
          nodes:
            cnt:
              kind: count
              in:
                list: ${item}
          result:
            state: ${nodes.cnt.out}
    """)
    # 简化：每次迭代 state = len(item)；最后 state = 最后一项的 len
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            f:
              kind: flow.foreach_with_state
              in:
                over:
                  - [1, 2, 3]
                  - [4, 5]
                init_state: 0
              params:
                body: ${subgraph:acc}
          result:
            final: ${nodes.f.final_state}
            collected: ${nodes.f.collected}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    # 最后一项 [4,5] len=2
    assert res.outputs["final"] == 2
    assert [r["state"] for r in res.outputs["collected"]] == [3, 2]


@pytest.mark.asyncio
async def test_flow_fanout_per_agent(tmp_path: Path) -> None:
    _write_subgraph(tmp_path, "agent_id_str", """\
        schema: g@1
        id: agent_id_str
        spec:
          nodes:
            r:
              kind: math.range
              params: {start: 0, end: 1}
          result:
            id: ${item.id}
    """)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: outer
        spec:
          nodes:
            f:
              kind: flow.fanout_per_agent
              in:
                over:
                  - {id: "a"}
                  - {id: "b"}
              params:
                body: ${subgraph:agent_id_str}
          result:
            collected: ${nodes.f.collected}
    """))
    eng = Engine(tmp_path)
    eng.services.spec_search_root = tmp_path
    res = await eng.run(spec, inputs={})
    assert [r["id"] for r in res.outputs["collected"]] == ["a", "b"]


def test_flow_kinds_registered() -> None:
    from tools.chronicle_sim_v3.engine.registry import list_kinds

    kinds = set(list_kinds())
    expected = {
        "flow.foreach", "flow.foreach_with_state", "flow.fanout_per_agent",
        "flow.parallel", "flow.when", "flow.switch", "flow.merge",
        "flow.subgraph", "flow.barrier",
    }
    assert expected.issubset(kinds), f"缺：{expected - kinds}"
