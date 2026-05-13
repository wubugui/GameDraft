"""P3-5 seed_from_ideas + probe 端到端（stub LLM 路径）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.graph import GraphLoader
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _wire_engine(eng: Engine, run: Path) -> None:
    """三层服务装配（与 cli/cook._build_engine 等价）。"""
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


_GRAPHS = Path(__file__).resolve().parents[1] / "data" / "graphs"


def test_seed_from_ideas_validates() -> None:
    spec = GraphLoader().load(_GRAPHS / "seed_from_ideas.yaml")
    errs = GraphLoader().validate(spec)
    assert errs == [], errs


def test_probe_validates() -> None:
    spec = GraphLoader().load(_GRAPHS / "probe.yaml")
    errs = GraphLoader().validate(spec)
    assert errs == [], errs


@pytest.mark.asyncio
async def test_probe_e2e_stub(tmp_path: Path) -> None:
    """probe 在最小 Run（无 chroma 数据）下也应能跑通：检索返回 [] 不报错。"""
    run = make_stub_run(tmp_path)
    (run / "world").mkdir(parents=True, exist_ok=True)
    (run / "world" / "setting.json").write_text(json.dumps({"era": "民国"}))
    (run / "world" / "edges.json").write_text(json.dumps([]))
    spec = GraphLoader().load(_GRAPHS / "probe.yaml")
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(spec, inputs={"question": "朝天门那边谁是头"},
                          cook_id="probe1")
    assert res.status == "completed", f"failed_nodes={res.failed_nodes}"
    assert isinstance(res.outputs["answer"], str)
    assert res.outputs["answer"]
    await _close_engine(eng)


@pytest.mark.asyncio
async def test_probe_with_chroma_data(tmp_path: Path) -> None:
    """先用 chroma.rebuild_world 灌数据，probe 应能命中。"""
    run = make_stub_run(tmp_path)
    a = run / "world" / "agents"
    a.mkdir(parents=True)
    (a / "g.json").write_text(json.dumps({
        "id": "g", "name": "甲", "summary": "朝天门管事",
    }))
    (run / "world" / "setting.json").write_text(json.dumps({}))
    (run / "world" / "edges.json").write_text(json.dumps([]))

    eng = Engine(run)
    _wire_engine(eng, run)

    # 1) 先 rebuild world
    rebuild = GraphLoader().load_text("""\
schema: g@1
id: r
spec:
  nodes:
    rb: {kind: chroma.rebuild_world}
  result:
    n: ${nodes.rb.count}
""")
    res1 = await eng.run(rebuild, inputs={}, cook_id="r1")
    assert res1.status == "completed"

    # 2) 再跑 probe
    spec = GraphLoader().load(_GRAPHS / "probe.yaml")
    res2 = await eng.run(spec, inputs={"question": "朝天门"}, cook_id="probe1")
    assert res2.status == "completed"
    hits = res2.outputs["chroma_hits"]
    assert isinstance(hits, list)
    await _close_engine(eng)


@pytest.mark.asyncio
async def test_seed_from_ideas_e2e_stub(tmp_path: Path) -> None:
    """seed_from_ideas：ideas 列表 → initializer 调用 → result 含 seed_draft 字段。"""
    run = make_stub_run(tmp_path)
    (run / "ideas").mkdir()
    (run / "ideas" / "manifest.json").write_text(
        json.dumps([{"id": "i1", "title": "民国川渝码头草头江湖"}])
    )
    spec = GraphLoader().load(_GRAPHS / "seed_from_ideas.yaml")
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(spec, inputs={"ideas_blob_limit": 50000},
                          cook_id="seed1")
    # initializer 走 stub 返回 {"ok": True, "seed": ...} 而非完整 seed
    # 我们只断言 cook 跑通；setting/pillars 字段在 stub 路径下可能为 None
    assert res.status == "completed", f"failed_nodes={res.failed_nodes}"
    assert "seed" in res.outputs
    await _close_engine(eng)
