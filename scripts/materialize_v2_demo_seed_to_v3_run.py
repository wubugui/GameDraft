"""把 v2 ``bootstrap_demo_full_seed_and_sim._demo_seed()`` 雾江埠种子落到 v3 Run 目录。

放在仓库根 ``scripts/``，避免 ``tools.chronicle_sim_v3`` 包内出现对 v2 的 import
（v3 分层测试禁止 v2 依赖）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def materialize(run_dir: Path, seed: dict) -> None:
    run_dir = Path(run_dir).resolve()
    w = run_dir / "world"
    (w / "agents").mkdir(parents=True, exist_ok=True)
    (w / "factions").mkdir(parents=True, exist_ok=True)
    (w / "locations").mkdir(parents=True, exist_ok=True)

    (w / "setting.json").write_text(
        json.dumps(seed.get("world_setting") or {}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    pillars = seed.get("design_pillars") or []
    (w / "pillars.json").write_text(
        json.dumps(pillars, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (w / "anchors.json").write_text("[]", encoding="utf-8")

    for fac in seed.get("factions") or []:
        fid = str(fac.get("id", ""))
        if fid:
            (w / "factions" / f"{fid}.json").write_text(
                json.dumps(fac, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    for loc in seed.get("locations") or []:
        lid = str(loc.get("id", ""))
        if lid:
            (w / "locations" / f"{lid}.json").write_text(
                json.dumps(loc, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    for ag in seed.get("agents") or []:
        aid = str(ag.get("id") or ag.get("name") or "")
        if not aid:
            continue
        row = dict(ag)
        tier = str(row.get("tier") or row.get("current_tier") or "C").upper()
        row["tier"] = tier
        if "life_status" not in row:
            row["life_status"] = "alive"
        (w / "agents" / f"{aid}.json").write_text(
            json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    edges_out: list[dict] = []
    for e in seed.get("relationships") or []:
        a = str(e.get("from_agent_id") or e.get("a") or "")
        b = str(e.get("to_agent_id") or e.get("b") or "")
        if not a or not b:
            continue
        wgt = float(e.get("strength", e.get("w", 1.0)) or 1.0)
        edges_out.append({"a": a, "b": b, "w": wgt, "type": str(e.get("edge_type", ""))})
    (w / "edges.json").write_text(
        json.dumps(edges_out, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "用法: python scripts/materialize_v2_demo_seed_to_v3_run.py <run_dir>",
            file=sys.stderr,
        )
        return 2
    run_dir = Path(sys.argv[1])
    # 延迟 import：仅从 v2 脚本取种子 dict
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo))
    from tools.chronicle_sim_v2.scripts.bootstrap_demo_full_seed_and_sim import (  # noqa: PLC0415
        _demo_seed,
    )

    materialize(run_dir, _demo_seed())
    print(f"已写入 v3 world: {run_dir.resolve() / 'world'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
