"""P3-6 golden 回归。

策略：
- fixture Run 在 tests/golden/runs/<scenario>/ 下手工准备
- 复制到 tmp_path 跑 graph
- 与 expected/cook_result.json 比对（白名单忽略 ts / uuid / audit_id 等不稳定字段）
- expected 文件首次生成由 `--update-golden` 标志写出（CI 不带此标志）
"""
from __future__ import annotations

import json
import os
import shutil
import textwrap
from pathlib import Path
from typing import Any

import pytest

from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.graph import GraphLoader
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


_GOLDEN_ROOT = Path(__file__).resolve().parent / "golden"
_GRAPHS = Path(__file__).resolve().parents[1] / "data" / "graphs"
_UPDATE = os.environ.get("V3_UPDATE_GOLDEN", "") == "1"


def _materialize_run(scenario: str, dst: Path) -> Path:
    """把 golden fixture 复制到 dst，并补 stub config（providers/llm/agents）。"""
    src = _GOLDEN_ROOT / "runs" / scenario
    if not src.is_dir():
        raise FileNotFoundError(f"golden fixture 不存在: {src}")
    dst_run = dst / scenario
    shutil.copytree(src, dst_run)
    cfg = dst_run / "config"
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / "providers.yaml").write_text(textwrap.dedent("""\
        schema: chronicle_sim_v3/providers@1
        providers:
          stub_local: {kind: stub}
        """), encoding="utf-8")
    (cfg / "llm.yaml").write_text(textwrap.dedent("""\
        schema: chronicle_sim_v3/llm@1
        models:
          stub: {provider: stub_local, invocation: stub}
          embed-stub: {provider: stub_local, invocation: stub}
        routes:
          offline: stub
          smart: stub
          embed: embed-stub
        cache:
          enabled: true
          default_mode: off
          per_route:
            smart: hash
            offline: hash
            embed: hash
        audit:
          enabled: true
        stub:
          fixed_seed: 7
        """), encoding="utf-8")
    (cfg / "agents.yaml").write_text(textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          cline_default:
            runner: simple_chat
            llm_route: smart
            timeout_sec: 60
          simple_chat_offline:
            runner: simple_chat
            llm_route: offline
            timeout_sec: 30
          simple_chat_default:
            runner: simple_chat
            llm_route: smart
            timeout_sec: 60
          react_default:
            runner: react
            llm_route: smart
            timeout_sec: 60
            config:
              max_iter: 4
              tools: ["read_key", "final"]
        routes:
          npc: cline_default
          director: cline_default
          gm: cline_default
          rumor: simple_chat_default
          summary: simple_chat_default
          initializer: cline_default
          probe: react_default
        limiter:
          per_runner:
            cline: 2
            simple_chat: 4
            react: 2
            external: 1
        cache:
          enabled: true
          default_mode: off
        audit:
          enabled: true
          log_user_prompt: true
        """), encoding="utf-8")
    return dst_run


_VOLATILE_KEYS = {
    "audit_id", "cook_id", "duration_ms", "started_at", "finished_at",
    "created_at", "ts", "run_id", "total_ms", "exec_ms", "auth_ms",
    "cache_ms",
    # agent 层引入
    "agent_run_id", "physical_agent", "runner_kind", "llm_calls_count",
    "llm_ms",
}


def _scrub(value: Any) -> Any:
    """递归剔除不稳定字段。"""
    if isinstance(value, dict):
        return {
            k: _scrub(v)
            for k, v in value.items()
            if k not in _VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


def _expected_path(scenario: str, name: str) -> Path:
    return _GOLDEN_ROOT / "runs" / scenario / "expected" / f"{name}.json"


def _compare_or_update(actual: Any, scenario: str, name: str) -> None:
    p = _expected_path(scenario, name)
    if _UPDATE or not p.is_file():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(actual, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if not _UPDATE:
            pytest.skip(f"首次生成 golden: {p}（已写入；下次跑会比对）")
        return
    expected = json.loads(p.read_text(encoding="utf-8"))
    assert actual == expected, (
        f"golden 不一致：{p}\n"
        f"set V3_UPDATE_GOLDEN=1 重写 expected"
    )


@pytest.mark.asyncio
async def test_golden_week_smoke(tmp_path: Path) -> None:
    """跑 week.yaml 在 week_smoke fixture 上，比对稳定字段。"""
    run = _materialize_run("week_smoke", tmp_path)
    spec = GraphLoader().load(_GRAPHS / "week.yaml")
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(spec, inputs={"week": 1}, cook_id="golden_w1")
    await _close_engine(eng)

    assert res.status == "completed", f"failed_nodes={res.failed_nodes}"
    actual = {
        "status": res.status,
        "outputs": _scrub(res.outputs),
        "failed_nodes": list(res.failed_nodes),
    }
    _compare_or_update(actual, "week_smoke", "cook_result")


@pytest.mark.asyncio
async def test_golden_week_smoke_node_outputs(tmp_path: Path) -> None:
    """更细粒度：抽 by_tier / intents_n / event_types_text 等纯算法节点的输出快照。"""
    run = _materialize_run("week_smoke", tmp_path)
    spec = GraphLoader().load(_GRAPHS / "week.yaml")
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(spec, inputs={"week": 1}, cook_id="golden_n1")
    await _close_engine(eng)
    assert res.status == "completed"

    cook_dir = run / "cooks" / "golden_n1"
    snapshot = {}
    for node in ("agents", "alive", "by_tier", "intents_n", "pacing_mult"):
        p = cook_dir / node / "output.json"
        if p.is_file():
            snapshot[node] = _scrub(json.loads(p.read_text(encoding="utf-8")))
    _compare_or_update(snapshot, "week_smoke", "node_outputs")


@pytest.mark.asyncio
async def test_golden_week_smoke_deterministic_across_runs(tmp_path: Path) -> None:
    """同一 fixture 跑两次 → 节点 output 完全一致（验证 stub 与算法的确定性）。"""
    spec = GraphLoader().load(_GRAPHS / "week.yaml")

    async def _run(suffix: str) -> dict:
        run = _materialize_run("week_smoke", tmp_path / suffix)
        eng = Engine(run)
        _wire_engine(eng, run)
        res = await eng.run(spec, inputs={"week": 1}, cook_id="d_" + suffix)
        await _close_engine(eng)
        return _scrub(res.outputs)

    a = await _run("a")
    b = await _run("b")
    assert a == b
