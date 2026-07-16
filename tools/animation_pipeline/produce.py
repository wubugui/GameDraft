"""One-click producer: a character's stabilized state clips -> game-ready
atlas.png + anim.json, gated by QA.

  python -m tools.animation_pipeline.produce \
      --clips-dir <dir with idle.mp4 run.mp4 ...> \
      --out <output dir> [--world-w 115 --world-h 150] [--matte fusion]
      [--states idle,slow_walk,run,jump,crouch,lie_down] [--skip-qa]

Flow (program-driven; agent is a called judge, not the driver):
  1. per-clip PROGRAM QA gate -> HARD_FAIL aborts; FLAG surfaces for the agent
  2. build character atlas (matte -> anchor+scale-norm -> loop -> 2K grid)
  3. atlas QA gate (<=2K, indices valid, png matches grid)
  4. write finals.json manifest (provenance + verdicts + agent-flags to adjudicate)

Exit code 0 only if all hard gates pass. Agent-flags do NOT block here — they are
reported for a human/VLM to adjudicate (see qa_gate.AGENT_SCHEMA).
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

from . import recipes
from . import pipeline
from . import qa_gate

DEFAULT_STATES = list(recipes.ACTIONS.keys())


def discover_clips(clips_dir: Path, states: list[str]) -> dict[str, str]:
    found = {}
    for st in states:
        p = clips_dir / f"{st}.mp4"
        if p.exists() and p.stat().st_size > 0:
            found[st] = str(p)
    return found


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Produce a game-ready sprite atlas from stabilized state clips.")
    ap.add_argument("--clips-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--states", default=",".join(DEFAULT_STATES))
    ap.add_argument("--world-w", type=float, default=100.0)
    ap.add_argument("--world-h", type=float, default=None)
    ap.add_argument("--matte", default=recipes.MATTE_PRIMARY)
    ap.add_argument("--skip-qa", action="store_true")
    args = ap.parse_args(argv)

    clips_dir = Path(args.clips_dir)
    out_dir = Path(args.out)
    states = [s.strip() for s in args.states.split(",") if s.strip()]
    clips = discover_clips(clips_dir, states)
    if not clips:
        print(f"[produce] no state clips found in {clips_dir}", file=sys.stderr)
        return 2

    report: dict = {"clips_dir": str(clips_dir), "out": str(out_dir),
                    "clip_qa": {}, "agent_flags": {}, "hard_failures": []}

    # 1. per-clip program QA
    if not args.skip_qa:
        for st, clip in clips.items():
            g = qa_gate.program_gate(clip, st)
            report["clip_qa"][st] = g["verdict"]
            if g["verdict"] == "HARD_FAIL":
                report["hard_failures"].append({"state": st, "checks": g["hard_fail"]})
            if g["flags"]:
                report["agent_flags"][st] = g["flags"]
        if report["hard_failures"]:
            print("[produce] HARD QA failures — aborting before build:")
            print(json.dumps(report["hard_failures"], ensure_ascii=False, indent=2))
            (out_dir).mkdir(parents=True, exist_ok=True)
            (out_dir / "finals.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return 1

    # 2. build atlas + anim.json
    summary = pipeline.build_character(clips, out_dir, world_w=args.world_w,
                                       world_h=args.world_h, matte_method=args.matte)
    report["build"] = summary

    # 3. atlas QA gate
    ag = qa_gate.atlas_gate(str(out_dir / "anim.json"), str(out_dir / "atlas.png"))
    report["atlas_qa"] = ag

    # 4. finals manifest
    report["status"] = "ok" if ag["verdict"] == "PASS" else "atlas_qa_failed"
    (out_dir / "finals.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("[produce] built:", json.dumps(summary, ensure_ascii=False))
    print("[produce] atlas QA:", ag["verdict"])
    if report["agent_flags"]:
        print("[produce] AGENT must adjudicate flags (see finals.json):")
        print(json.dumps(report["agent_flags"], ensure_ascii=False, indent=2))
    return 0 if ag["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
