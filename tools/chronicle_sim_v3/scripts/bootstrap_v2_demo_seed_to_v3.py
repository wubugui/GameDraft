"""把 v2 demo seed 转成 v3 run，并可选直接跑 week/range。

用法示例：
    python3 tools/chronicle_sim_v3/scripts/bootstrap_v2_demo_seed_to_v3.py \
      --run-dir /tmp/csim-v3-real \
      --week 1

    python3 tools/chronicle_sim_v3/scripts/bootstrap_v2_demo_seed_to_v3.py \
      --run-dir /tmp/csim-v3-small \
      --small \
      --week 1

环境变量：
    DASHSCOPE_TEMP_KEY                 必填
    CHRONICLE_SIM_V3_BASE_URL         可选，默认 DashScope coding base
    CHRONICLE_SIM_V3_MODEL            可选，默认 qwen3.5-plus
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import json
import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import tools.chronicle_sim_v3.nodes  # noqa: F401
from tools.chronicle_sim_v2.scripts.bootstrap_demo_full_seed_and_sim import _demo_seed
from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.engine.graph import GraphLoader
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService

_DEFAULT_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1"
_DEFAULT_MODEL = "qwen3.5-plus"


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True, help="目标 v3 run 目录")
    p.add_argument("--week", type=int, default=0, help="若 > 0 则直接跑单周")
    p.add_argument("--from-week", type=int, default=0, help="多周起始（与 --to-week 配对）")
    p.add_argument("--to-week", type=int, default=0, help="多周结束（闭区间）")
    p.add_argument("--small", action="store_true", help="只保留缩小版 seed 以更快真实验证")
    return p


def _provider_block() -> tuple[str, str]:
    key = (os.environ.get("DASHSCOPE_TEMP_KEY") or "").strip()
    if not key:
        raise SystemExit("缺少环境变量 DASHSCOPE_TEMP_KEY")
    base_url = (os.environ.get("CHRONICLE_SIM_V3_BASE_URL") or _DEFAULT_BASE_URL).strip()
    model = (os.environ.get("CHRONICLE_SIM_V3_MODEL") or _DEFAULT_MODEL).strip()
    return base_url, model


def _smallen_seed(seed: dict) -> dict:
    keep_ids = {"npc_s_01", "npc_a_01", "npc_b_01", "npc_b_02", "npc_c_01", "npc_c_02"}
    seed = dict(seed)
    seed["agents"] = [a for a in seed.get("agents", []) if a.get("id") in keep_ids]
    seed["relationships"] = [
        r for r in seed.get("relationships", [])
        if r.get("from_agent_id") in keep_ids and r.get("to_agent_id") in keep_ids
    ]
    return seed


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _bootstrap_world(run_dir: Path, seed: dict) -> None:
    world = run_dir / "world"
    (world / "agents").mkdir(parents=True, exist_ok=True)
    (world / "factions").mkdir(parents=True, exist_ok=True)
    (world / "locations").mkdir(parents=True, exist_ok=True)
    (world / "agent_personality").mkdir(parents=True, exist_ok=True)

    _write_json(world / "setting.json", seed["world_setting"])
    _write_json(world / "pillars.json", seed.get("design_pillars", []))
    _write_json(world / "anchors.json", [])

    edges = []
    for rel in seed.get("relationships", []):
        edges.append(
            {
                "a": rel.get("from_agent_id"),
                "b": rel.get("to_agent_id"),
                "w": rel.get("strength", 0.5),
                "edge_type": rel.get("edge_type", ""),
            }
        )
    _write_json(world / "edges.json", edges)

    for fac in seed.get("factions", []):
        item = dict(fac)
        item.setdefault("summary", item.get("description", ""))
        _write_json(world / "factions" / f"{item['id']}.json", item)

    for loc in seed.get("locations", []):
        item = dict(loc)
        item.setdefault("summary", item.get("description", ""))
        _write_json(world / "locations" / f"{item['id']}.json", item)

    for agent in seed.get("agents", []):
        item = dict(agent)
        item["tier"] = item.get("current_tier") or item.get("tier") or "B"
        item.setdefault("life_status", "alive")
        item.setdefault("current_location", item.get("location_hint", ""))
        _write_json(world / "agents" / f"{item['id']}.json", item)
        personality = {
            "agent_id": item["id"],
            "persona": item.get("personality", ""),
            "tier": item["tier"],
            "faction_hint": item.get("faction_hint", ""),
            "location_hint": item.get("location_hint", ""),
        }
        _write_json(world / "agent_personality" / f"{item['id']}.json", personality)


def _write_configs(run_dir: Path, *, base_url: str, model: str) -> None:
    cfg = run_dir / "config"
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / "providers.yaml").write_text(
        (
            "schema: chronicle_sim_v3/providers@1\n"
            "providers:\n"
            "  dashscope_coding:\n"
            "    kind: openai_compat\n"
            f"    base_url: {base_url}\n"
            "    api_key_ref: env:DASHSCOPE_TEMP_KEY\n"
        ),
        encoding="utf-8",
    )
    (cfg / "llm.yaml").write_text(
        (
            "schema: chronicle_sim_v3/llm@1\n"
            "models:\n"
            "  stub:\n"
            "    provider: dashscope_coding\n"
            "    invocation: openai_compat_chat\n"
            "routes:\n"
            "  offline: stub\n"
            "  smart: stub\n"
            "  fast: stub\n"
            "  embed: stub\n"
            "cache:\n"
            "  enabled: false\n"
            "audit:\n"
            "  enabled: true\n"
            "providers_ref: config/providers.yaml\n"
        ),
        encoding="utf-8",
    )
    (cfg / "agents.yaml").write_text(
        (
            "schema: chronicle_sim_v3/agents@1\n"
            "agents:\n"
            "  cline_default:\n"
            "    runner: cline\n"
            "    provider: dashscope_coding\n"
            f"    model_id: {model}\n"
            "    timeout_sec: 240\n"
            "    config:\n"
            "      cline_stream_stderr: true\n"
            "routes:\n"
            "  npc: cline_default\n"
            "  director: cline_default\n"
            "  gm: cline_default\n"
            "  rumor: cline_default\n"
            "  summary: cline_default\n"
            "  initializer: cline_default\n"
            "cache:\n"
            "  enabled: false\n"
            "audit:\n"
            "  enabled: true\n"
        ),
        encoding="utf-8",
    )


def _cook_suffix() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d%H%M%S")


async def _run_graph(run_dir: Path, graph_name: str, inputs: dict[str, object], cook_id: str) -> None:
    spec = GraphLoader().load(Path("/workspace/tools/chronicle_sim_v3/data/graphs") / f"{graph_name}.yaml")
    eng = Engine(run_dir)
    ps = ProviderService(run_dir)
    llm = LLMService(run_dir, ps, spec_search_root=run_dir)
    agents = AgentService(run_dir, ps, llm_service=llm, spec_search_root=run_dir)
    eng.services.spec_search_root = run_dir
    eng.services._llm = llm
    eng.services.agents = agents
    try:
        res = await eng.run(spec, inputs=inputs, cook_id=cook_id)
        print("STATUS=", res.status)
        print("FAILED=", res.failed_nodes)
        print("OUTPUTS=", json.dumps(res.outputs, ensure_ascii=False))
    finally:
        await agents.aclose()
        await llm.aclose()


async def _run_storyline_aggregation(run_dir: Path, from_week: int, to_week: int) -> None:
    ps = ProviderService(run_dir)
    llm = LLMService(run_dir, ps, spec_search_root=run_dir)
    agents = AgentService(run_dir, ps, llm_service=llm, spec_search_root=run_dir)
    try:
        from tools.chronicle_sim_v3.agents.types import AgentRef, AgentTask
        from tools.chronicle_sim_v3.engine.context import ContextStore
        from tools.chronicle_sim_v3.engine.keymap import scan_keys

        cs = ContextStore(run_dir)
        clusters: list[dict] = []
        for key in scan_keys("chronicle.story_clusters_all", run_dir):
            payload = cs.read_view().read_key(key)
            if payload is None:
                continue
            clusters.append({"key": key, "payload": payload})
        ref = AgentRef(
            agent="summary",
            role="storyline_aggregator",
            output_kind="json_object",
            artifact_filename="agent_output.json",
            cache="off",
            timeout_sec=240,
        )
        task = AgentTask(
            spec_ref="data/agent_specs/storyline_aggregator.toml",
            vars={
                "weekly_clusters_text": json.dumps(clusters, ensure_ascii=False, indent=2),
            },
        )
        result = await agents.run(ref, task)
        out = result.parsed if isinstance(result.parsed, dict) else {"storylines": []}
        target = run_dir / "chronicle" / "storylines" / f"from_{from_week:03d}_to_{to_week:03d}.json"
        _write_json(target, out)
        print("STORYLINES_WRITTEN=", target)
    finally:
        await agents.aclose()
        await llm.aclose()


def main() -> None:
    args = _build_parser().parse_args()
    run_dir = Path(args.run_dir).resolve()
    base_url, model = _provider_block()
    seed = _demo_seed()
    if args.small:
        seed = _smallen_seed(seed)
    _write_configs(run_dir, base_url=base_url, model=model)
    _bootstrap_world(run_dir, seed)
    print(f"BOOTSTRAPPED_RUN={run_dir}")
    print(f"AGENTS={len(seed.get('agents', []))}")

    if args.week > 0:
        asyncio.run(
            _run_graph(
                run_dir,
                "week",
                {"week": args.week},
                f"real-w{args.week}-{_cook_suffix()}",
            )
        )
    elif args.from_week > 0 and args.to_week >= args.from_week:
        for week in range(args.from_week, args.to_week + 1):
            asyncio.run(
                _run_graph(
                    run_dir,
                    "week",
                    {"week": week},
                    f"real-w{week}-{_cook_suffix()}",
                )
            )
        asyncio.run(_run_storyline_aggregation(run_dir, args.from_week, args.to_week))


if __name__ == "__main__":
    main()
