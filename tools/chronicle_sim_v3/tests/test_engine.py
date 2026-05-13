"""Engine 调度核心：4 节点线性 / cache 命中 / cancel / resume。"""
from __future__ import annotations

import asyncio
import json
import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.cancel import CancelToken
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.graph import GraphLoader
import tools.chronicle_sim_v3.nodes  # noqa: F401  注册


def _seed_world(run_dir: Path) -> None:
    a = run_dir / "world" / "agents"
    a.mkdir(parents=True, exist_ok=True)
    for i, life in enumerate([
        ("a", "alive"), ("b", "alive"), ("c", "dead"),
    ]):
        (a / f"{life[0]}.json").write_text(
            json.dumps({"id": life[0], "life_status": life[1]})
        )


_GRAPH = """\
schema: g@1
id: smoke
spec:
  nodes:
    agents:
      kind: read.world.agents
    alive:
      kind: npc.filter_active
      in:
        agents: ${nodes.agents.out}
    cnt:
      kind: count
      in:
        list: ${nodes.alive.out}
  result:
    n: ${nodes.cnt.out}
"""


@pytest.mark.asyncio
async def test_engine_linear_4_nodes(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    res = await eng.run(spec, inputs={"week": 1})
    assert res.status == "completed"
    assert res.outputs["n"] == 2  # a, b alive
    cooks = list((tmp_path / "cooks").iterdir())
    assert len(cooks) == 1
    assert (cooks[0] / "result.json").is_file()
    assert (cooks[0] / "agents" / "output.json").is_file()


@pytest.mark.asyncio
async def test_engine_cache_hit_on_second_run(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    r1 = await eng.run(spec, inputs={"week": 1})
    eng2 = Engine(tmp_path)
    r2 = await eng2.run(spec, inputs={"week": 1}, cook_id="r2")
    assert r1.outputs == r2.outputs
    # 第二次跑应有 cache_hit 文件
    hit_files = list((tmp_path / "cooks" / "r2").rglob("cache_hit.txt"))
    assert hit_files, "二次跑未命中任何缓存"


@pytest.mark.asyncio
async def test_engine_cache_miss_on_input_change(tmp_path: Path) -> None:
    """改 world 数据 → 下游 read.world.agents 的 reads slice 变化 → miss。"""
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    r1 = await eng.run(spec, inputs={"week": 1}, cook_id="r1")

    # 改 world 数据
    (tmp_path / "world" / "agents" / "d.json").write_text(
        json.dumps({"id": "d", "life_status": "alive"})
    )
    eng2 = Engine(tmp_path)
    r2 = await eng2.run(spec, inputs={"week": 1}, cook_id="r2")
    assert r2.outputs["n"] == 3
    # cnt 节点不应命中（因为上游 alive 输出变了）
    cnt_hit = (tmp_path / "cooks" / "r2" / "cnt" / "cache_hit.txt").exists()
    assert cnt_hit is False


@pytest.mark.asyncio
async def test_engine_no_cache(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    await eng.run(spec, inputs={"week": 1}, cook_id="r1")
    eng2 = Engine(tmp_path)
    await eng2.run(spec, inputs={"week": 1}, cook_id="r2", cache_enabled=False)
    hit_files = list((tmp_path / "cooks" / "r2").rglob("cache_hit.txt"))
    assert not hit_files


@pytest.mark.asyncio
async def test_engine_serial_concurrency_off(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    res = await eng.run(spec, inputs={"week": 1}, concurrency_enabled=False)
    assert res.status == "completed"


@pytest.mark.asyncio
async def test_engine_node_failure_marks_cook_failed(tmp_path: Path) -> None:
    """注入一个会失败的节点（template.render 缺 var）。"""
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: x
        spec:
          nodes:
            agents:
              kind: read.world.agents
            tpl:
              kind: template.render
              in:
                vars: {}
              params:
                template: "{{missing}}"
        """))
    eng = Engine(tmp_path)
    res = await eng.run(spec, inputs={})
    assert res.status == "failed"
    assert "tpl" in res.failed_nodes


@pytest.mark.asyncio
async def test_engine_cancel(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    cancel = CancelToken()
    cancel.cancel()  # 立即取消
    res = await eng.run(spec, inputs={"week": 1}, cancel=cancel)
    assert res.status == "cancelled"


@pytest.mark.asyncio
async def test_engine_writes_audit(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    await eng.run(spec, inputs={"week": 1})
    audits = list((tmp_path / "audit" / "nodes").glob("*.jsonl"))
    assert audits, "节点审计未写"
    text = audits[0].read_text(encoding="utf-8")
    assert "agents" in text
    assert "cnt" in text


@pytest.mark.asyncio
async def test_engine_resume(tmp_path: Path) -> None:
    """模拟中断后 resume。"""
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    res = await eng.run(spec, inputs={"week": 1}, cook_id="rc")
    # 把 result.json 删除模拟中断
    (tmp_path / "cooks" / "rc" / "result.json").unlink()
    state = (tmp_path / "cooks" / "rc" / "state.json")
    d = json.loads(state.read_text(encoding="utf-8"))
    d["status"] = "running"
    d["nodes"]["cnt"]["status"] = "running"
    state.write_text(json.dumps(d), encoding="utf-8")
    eng2 = Engine(tmp_path)
    res2 = await eng2.resume("rc", spec)
    assert res2.status == "completed"
    assert res2.outputs["n"] == 2


@pytest.mark.asyncio
async def test_engine_eventbus_emits(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent(_GRAPH))
    eng = Engine(tmp_path)
    seen = []
    eng.bus.subscribe(lambda e: seen.append(e["event"]))
    await eng.run(spec, inputs={"week": 1})
    assert "cook.start" in seen
    assert "cook.end" in seen
    assert seen.count("node.start") == 3
    assert seen.count("node.end") == 3


@pytest.mark.asyncio
async def test_engine_when_skips_node(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    spec = GraphLoader().load_text(textwrap.dedent("""\
        schema: g@1
        id: x
        spec:
          nodes:
            agents:
              kind: read.world.agents
            cnt:
              kind: count
              in:
                list: ${nodes.agents.out}
              when: "${ctx.week == 99}"
        """))
    eng = Engine(tmp_path)
    res = await eng.run(spec, inputs={"week": 1})
    assert res.status == "completed"
    cooks = list((tmp_path / "cooks").iterdir())
    # cnt 应被跳过
    cnt_dir = cooks[0] / "cnt"
    assert cnt_dir.is_dir()
