"""写入范例种子（S×5、A×10、B/C×20）并顺序模拟至第 N 周（默认 8，触发第 4、8 周两次月史）。

不调用 initializer / probe；编排与 GUI 相同，走 ``simulation_pipeline.run_week_async``。

用法（在仓库根目录，密钥用环境变量，勿写入仓库）::

    set PYTHONPATH=%CD%
    set CHRONICLE_SIM_API_KEY=你的密钥
    set CHRONICLE_SIM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
    set CHRONICLE_SIM_MODEL=kimi-k2.5
    python tools\\chronicle_sim_v2\\scripts\\bootstrap_demo_full_seed_and_sim.py

可选：``CHRONICLE_SIM_END_WEEK``（默认 8）、``CHRONICLE_SIM_RUN_NAME``。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


def _demo_seed() -> dict:
    """雾江埠：5 名 S、10 名 A、10 名 B + 10 名 C；社交图连成片便于谣言多跳。"""
    world_setting = {
        "id": "ws_chongqing_demo",
        "name": "雾江埠",
        "description": (
            "民国初年川江码头边的商埠，袍哥与脚帮并存，茶烟与债务交织。"
            "志怪只在口耳相传里露头，白日里仍是柴米与面子。"
        ),
        "era": "1910s",
        "tone": "克制、方言感、人情债",
    }
    factions = [
        {
            "id": "fac_paoge",
            "name": "袍哥会",
            "description": "码头与场面上说话算数的帮会网络，讲规矩也讲面子。",
            "weekly_pressure": "本周堂口：码头纠纷先压后报，莫在外头乱嚼舌根。",
        },
        {
            "id": "fac_jiaobang",
            "name": "脚帮",
            "description": "扛抬苦力结成的互助行会，消息在汗衫底下传得最快。",
        },
    ]
    locations = [
        {"id": "loc_teahouse", "name": "望江茶馆", "description": "二层木楼，江风穿堂，是是非非的集散地。"},
        {"id": "loc_dock", "name": "朝天门码头", "description": "货栈、缆绳、吆喝与暗盘交易。"},
        {"id": "loc_alley", "name": "背街米仓", "description": "潮气与鼠迹，欠条与隔夜粮。"},
        {"id": "loc_market", "name": "早市栅口", "description": "菜担与赊账，口舌与短打。"},
    ]
    loc_cycle = ["loc_teahouse", "loc_dock", "loc_alley", "loc_market"]

    s_names = ["沈把子", "贺舵爷", "赵袍头", "钱堂主", "孙管事"]
    agents: list[dict] = []
    for i in range(1, 6):
        agents.append(
            {
                "id": f"npc_s_{i:02d}",
                "name": s_names[i - 1],
                "current_tier": "S",
                "tier": "S",
                "life_status": "alive",
                "personality": "重场面、讲规矩、话少事多",
                "current_location": "望江茶馆" if i % 2 else "朝天门码头",
                "faction_hint": "袍哥会",
                "location_hint": loc_cycle[(i - 1) % 4],
            }
        )

    a_roles = [
        ("账房", "精细、好面子"),
        ("郎中", "心软嘴硬"),
        ("管事", "八面玲珑"),
        ("镖头", "外硬内软"),
        ("盐商", "算盘响、胆子小"),
        ("船老大", "认潮、认人"),
        ("讼师", "咬文嚼字"),
        ("米铺东", "斤斤计较"),
        ("茶博士", "耳听八方"),
        ("仓司", "夜里点灯对账"),
    ]
    for i in range(1, 11):
        tag, pers = a_roles[i - 1]
        agents.append(
            {
                "id": f"npc_a_{i:02d}",
                "name": f"{tag}{i:02d}",
                "current_tier": "A",
                "tier": "A",
                "life_status": "alive",
                "personality": pers,
                "current_location": "望江茶馆" if i % 3 else "背街米仓",
                "location_hint": loc_cycle[i % 4],
            }
        )

    for i in range(1, 11):
        agents.append(
            {
                "id": f"npc_b_{i:02d}",
                "name": f"脚力{i:02d}",
                "current_tier": "B",
                "tier": "B",
                "life_status": "alive",
                "personality": "憨厚怕事、听风就是雨",
                "current_location": "朝天门码头",
                "location_hint": "loc_dock",
            }
        )

    for i in range(1, 11):
        agents.append(
            {
                "id": f"npc_c_{i:02d}",
                "name": f"跑腿{i:02d}",
                "current_tier": "C",
                "tier": "C",
                "life_status": "alive",
                "personality": "机灵、爱打听",
                "current_location": "早市栅口" if i % 2 else "朝天门码头",
                "location_hint": "loc_market" if i % 2 else "loc_dock",
            }
        )

    relationships: list[dict] = []
    # 每名 S 连两名 A（覆盖 A01–A10）
    for i in range(1, 6):
        relationships.append(
            {
                "from_agent_id": f"npc_s_{i:02d}",
                "to_agent_id": f"npc_a_{2 * i - 1:02d}",
                "strength": 0.85,
                "edge_type": "袍哥场面上的线",
            }
        )
        relationships.append(
            {
                "from_agent_id": f"npc_s_{i:02d}",
                "to_agent_id": f"npc_a_{2 * i:02d}",
                "strength": 0.8,
                "edge_type": "袍哥场面上的线",
            }
        )
    # A 与 B 一一挂钩，再把 B、C 连成环并交叉
    for i in range(1, 11):
        relationships.append(
            {
                "from_agent_id": f"npc_a_{i:02d}",
                "to_agent_id": f"npc_b_{i:02d}",
                "strength": 0.7,
                "edge_type": "码头上照面",
            }
        )
    for i in range(1, 10):
        relationships.append(
            {
                "from_agent_id": f"npc_b_{i:02d}",
                "to_agent_id": f"npc_b_{i + 1:02d}",
                "strength": 0.75,
                "edge_type": "脚帮同棚",
            }
        )
    relationships.append(
        {"from_agent_id": "npc_b_10", "to_agent_id": "npc_b_01", "strength": 0.72, "edge_type": "脚帮同棚"}
    )
    for i in range(1, 10):
        relationships.append(
            {
                "from_agent_id": f"npc_c_{i:02d}",
                "to_agent_id": f"npc_c_{i + 1:02d}",
                "strength": 0.68,
                "edge_type": "街面上串话",
            }
        )
    relationships.append(
        {"from_agent_id": "npc_c_10", "to_agent_id": "npc_c_01", "strength": 0.65, "edge_type": "街面上串话"}
    )
    for i in range(1, 11):
        relationships.append(
            {
                "from_agent_id": f"npc_b_{i:02d}",
                "to_agent_id": f"npc_c_{i:02d}",
                "strength": 0.78,
                "edge_type": "茶钱脚钱",
            }
        )
    # S 之间也有弱连接，便于跨堂口传闻
    for i in range(1, 5):
        relationships.append(
            {
                "from_agent_id": f"npc_s_{i:02d}",
                "to_agent_id": f"npc_s_{i + 1:02d}",
                "strength": 0.55,
                "edge_type": "同会不同堂",
            }
        )

    return {
        "world_setting": world_setting,
        "factions": factions,
        "locations": locations,
        "agents": agents,
        "relationships": relationships,
        "design_pillars": ["川渝方言感", "民国市井", "克制志怪"],
    }


def _llm_block_from_env() -> dict:
    key = (os.environ.get("CHRONICLE_SIM_API_KEY") or "").strip()
    if not key:
        print(
            "缺少环境变量 CHRONICLE_SIM_API_KEY。"
            "可选：CHRONICLE_SIM_BASE_URL、CHRONICLE_SIM_MODEL。",
            file=sys.stderr,
        )
        raise SystemExit(2)
    base = (
        os.environ.get("CHRONICLE_SIM_BASE_URL", "").strip()
        or "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    model = (os.environ.get("CHRONICLE_SIM_MODEL", "").strip() or "kimi-k2.5")
    return {
        "kind": "openai_compat",
        "base_url": base,
        "api_key": key,
        "model": model,
    }


def _full_llm_config(block: dict) -> dict:
    out: dict = {"default": dict(block)}
    for k in (
        "tier_s_npc",
        "tier_a_npc",
        "tier_b_npc",
        "gm",
        "director",
        "rumor",
        "week_summarizer",
        "month_historian",
        "style_rewriter",
    ):
        out[k] = {**block, "override": True}
    return out


async def _run(end_week: int, run_dir: Path, log) -> None:
    from tools.chronicle_sim_v2.core.llm.cline_workspace import ensure_mcp_for_run
    from tools.chronicle_sim_v2.core.sim.simulation_pipeline import run_week_async
    from tools.chronicle_sim_v2.core.world.seed_writer import write_seed_to_fs

    ensure_mcp_for_run(run_dir)
    seed = _demo_seed()
    write_seed_to_fs(run_dir, seed)
    n = len(seed["agents"])
    log(f"[bootstrap] 已写入范例种子（共 {n} 名 NPC：S×5 A×10 B×10 C×10）→ {run_dir}")

    for w in range(1, end_week + 1):
        log(f"\n===== 模拟第 {w} 周 / {end_week} =====")
        r = await run_week_async(run_dir, w, progress_log=log)
        log(f"第 {w} 周完成: {r}")
    log("\n全部周次完成。")


def main() -> int:
    end_week = int(os.environ.get("CHRONICLE_SIM_END_WEEK", "8"))
    name = os.environ.get("CHRONICLE_SIM_RUN_NAME", "demo_scale_seed").strip() or "demo_scale_seed"

    from tools.chronicle_sim_v2.core.sim.run_manager import create_run, save_llm_config

    run_id, run_dir = create_run(name, start_week=1, total_weeks=max(52, end_week))
    save_llm_config(run_dir, _full_llm_config(_llm_block_from_env()))

    def log(msg: str) -> None:
        print(msg, flush=True)

    log(f"[bootstrap] run_id={run_id} run_dir={run_dir.resolve()} end_week={end_week}")
    asyncio.run(_run(end_week, run_dir, log))
    month_files = sorted((run_dir / "chronicle").glob("month_*.md"))
    log(f"[bootstrap] 月志文件: {[p.name for p in month_files]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
