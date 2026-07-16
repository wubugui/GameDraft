from __future__ import annotations

import argparse
import json
from pathlib import Path

from .analyzer import analyze
from .render import write_outputs
from .scanner import scan_project


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit project skills and workflows.")
    sub = parser.add_subparsers(dest="command")

    audit = sub.add_parser("audit", help="scan the project and write registry/report/dashboard outputs")
    audit.add_argument("--root", default=".", help="project root to scan")
    audit.add_argument("--out", default="tools/skill_workflow_governance/out", help="output directory")
    audit.add_argument("--stale-days", type=int, default=45, help="flag artifacts older than this many days; 0 disables")
    audit.add_argument("--drift-days", type=int, default=14, help="flag docs/skills when referenced files are newer by this many days; 0 disables")
    audit.add_argument("--json", action="store_true", help="print the registry JSON to stdout")

    args = parser.parse_args(argv)
    if args.command is None:
        args = parser.parse_args(["audit", *(argv or [])])

    if args.command == "audit":
        root = Path(args.root).resolve()
        out = Path(args.out)
        if not out.is_absolute():
            out = root / out
        artifacts = scan_project(root)
        result = analyze(root, artifacts, stale_days=args.stale_days, drift_days=args.drift_days)
        paths = write_outputs(result, out)
        if args.json:
            print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        else:
            print(f"Artifacts: {result.stats['artifact_count']}")
            print(f"Issues:    {result.stats['issue_count']}")
            for name, path in paths.items():
                print(f"{name}: {path}")
        return 0

    parser.error(f"unknown command: {args.command}")
    return 2
