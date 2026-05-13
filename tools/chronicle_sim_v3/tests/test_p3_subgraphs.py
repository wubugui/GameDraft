"""P3-3 子图加载 + 校验 + 独立 cook 跑通。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.expr import SubgraphRef
from tools.chronicle_sim_v3.engine.graph import GraphLoader
from tools.chronicle_sim_v3.engine.subgraph import SubgraphLoader
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _wire_engine(eng: Engine, run: Path) -> None:
    ps = ProviderService(run)
    llm = LLMService(run, ps, spec_search_root=run)
    agents = AgentService(
        run, ps, llm_service=llm,
        chroma=eng.services.chroma, spec_search_root=run,
    )
    eng.services.spec_search_root = run
    eng.services._llm = llm
    eng.services.agents = agents


async def _close_engine(eng: Engine) -> None:
    if eng.services.agents:
        await eng.services.agents.aclose()
    if eng.services._llm:
        await eng.services._llm.aclose()


_SUBGRAPHS = ["npc_context_compose", "single_agent_intent", "week_end"]


@pytest.mark.parametrize("name", _SUBGRAPHS)
def test_subgraph_loadable(name: str) -> None:
    spec = SubgraphLoader().load(SubgraphRef(name=name))
    assert spec.id == name


@pytest.mark.parametrize("name", _SUBGRAPHS)
def test_subgraph_validates(name: str) -> None:
    loader = GraphLoader()
    spec = SubgraphLoader().load(SubgraphRef(name=name))
    errors = loader.validate(spec)
    assert errors == [], f"{name} 校验失败：{errors}"


def _seed_world(rd: Path) -> None:
    (rd / "world").mkdir(parents=True, exist_ok=True)
    (rd / "world" / "setting.json").write_text(
        json.dumps({"era": "民国", "region": "川渝"})
    )
    (rd / "world" / "edges.json").write_text(json.dumps([]))


@pytest.mark.asyncio
async def test_npc_context_compose_runs(tmp_path: Path) -> None:
    """直接 cook npc_context_compose 子图。"""
    run = make_stub_run(tmp_path)
    _seed_world(run)
    spec = SubgraphLoader().load(SubgraphRef(name="npc_context_compose"))
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(
        spec, inputs={"agent_id": "npc_x", "week": 3},
    )
    assert res.status == "completed"
    assert "context_text" in res.outputs
    assert isinstance(res.outputs["context_text"], str)
    assert "世界设定" in res.outputs["context_text"]
    await _close_engine(eng)


@pytest.mark.asyncio
async def test_week_end_runs(tmp_path: Path) -> None:
    """跑 week_end 子图（无 events/rumors → summary 仍生成）。"""
    run = make_stub_run(tmp_path)
    _seed_world(run)
    spec = SubgraphLoader().load(SubgraphRef(name="week_end"))
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(spec, inputs={"week": 1})
    assert res.status == "completed"
    assert res.outputs.get("written_key") == "chronicle.summary:week=1"
    # summary 文件应被写入
    p = run / "chronicle" / "week_001" / "summary.md"
    assert p.is_file()
    assert p.read_text(encoding="utf-8")
    await _close_engine(eng)


@pytest.mark.asyncio
async def test_single_agent_intent_via_fanout(tmp_path: Path) -> None:
    """模拟 fanout_per_agent 调用：item=agent dict 时子图能跑。"""
    run = make_stub_run(tmp_path)
    _seed_world(run)
    # 通过外层图 fanout_per_agent 调用 single_agent_intent
    spec = GraphLoader().load_text("""\
schema: g@1
id: outer
spec:
  nodes:
    f:
      kind: flow.fanout_per_agent
      in:
        over:
          - {id: "a", tier: "S"}
          - {id: "b", tier: "S"}
      params:
        body: ${subgraph:single_agent_intent}
        body_inputs:
          tier: "S"
          agent_spec: data/agent_specs/tier_s_npc.toml
          week: 3
  result:
    n_intents: ${len(nodes.f.collected)}
""")
    eng = Engine(run)
    _wire_engine(eng, run)
    seen_failed: list = []
    eng.bus.subscribe(lambda e: seen_failed.append(e) if "fail" in e.get("event", "") else None)
    res = await eng.run(spec, inputs={})
    assert res.status == "completed", f"failed_nodes={res.failed_nodes} events={seen_failed}"
    assert res.outputs.get("n_intents") == 2
    await _close_engine(eng)
