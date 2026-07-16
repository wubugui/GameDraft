#!/usr/bin/env python3
"""Console launcher: run the audit and open the generated dashboard."""

from __future__ import annotations

import sys
import webbrowser
from pathlib import Path


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from skill_workflow_governance.cli import main as audit_main  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0].startswith("-"):
        args = ["audit", *args]
    code = audit_main(args)
    if code == 0:
        dashboard = HERE / "out" / "dashboard.html"
        if dashboard.exists():
            webbrowser.open(dashboard.resolve().as_uri())
            print(f"opened: {dashboard}", flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
