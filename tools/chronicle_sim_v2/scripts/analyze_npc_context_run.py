"""检查 Run 前两周 NPC 上下文产物是否齐全（可观察、公开摘要、信念、意图结果）。

用法::

    set PYTHONPATH=%CD%
    python tools\\chronicle_sim_v2\\scripts\\analyze_npc_context_run.py <run_dir> --to 2
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))

from tools.chronicle_sim_v2.core.world.fs import read_json
from tools.chronicle_sim_v2.core.world.week_state import week_dir_name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir", type=Path)
    ap.add_argument("--to", type=int, default=2)
    args = ap.parse_args()
    run = args.run_dir.resolve()
    for w in range(1, args.to + 1):
        wd = run / "chronicle" / week_dir_name(w)
        print(f"\n=== week {w} ===")
        obs = read_json(run, f"chronicle/{week_dir_name(w)}/world_observation.json")
        pub = read_json(run, f"chronicle/{week_dir_name(w)}/public_digest.json")
        print("world_observation:", "ok" if isinstance(obs, dict) and obs.get("locations") is not None else "missing")
        n_pub = len(pub.get("notices", [])) if isinstance(pub, dict) else 0
        print(f"public_digest notices: {n_pub}")
        bel_dir = wd / "beliefs"
        n_bel = len(list(bel_dir.glob("*.json"))) if bel_dir.is_dir() else 0
        print(f"belief files: {n_bel}")
        out_dir = wd / "intent_outcomes"
        n_out = len(list(out_dir.glob("*.json"))) if out_dir.is_dir() else 0
        print(f"intent_outcome files: {n_out}")
        cfg = read_json(run, "config/llm_config.json")
        model = (cfg.get("default") or {}).get("model") if isinstance(cfg, dict) else None
        print(f"llm_config.default.model: {model!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
