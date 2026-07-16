#!/usr/bin/env python3
"""Reject unfinished runtime shortcuts while allowing source-authored fallbacks."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


PORT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_ROOT = PORT_ROOT / "scripts"
SCENES_ROOT = PORT_ROOT.parent / "public/assets/scenes"


def main() -> int:
    errors: list[str] = []
    standalone_pass = re.compile(r"^\s*pass\s*(?:#.*)?$")
    unfinished = re.compile(r"\b(?:TODO|FIXME|NotImplemented)\b", re.IGNORECASE)

    for path in sorted(SCRIPTS_ROOT.rglob("*.gd")):
        relative = path.relative_to(PORT_ROOT)
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if standalone_pass.match(line):
                errors.append(f"{relative}:{line_number}: standalone pass")
            if unfinished.search(line):
                errors.append(f"{relative}:{line_number}: unfinished marker")

    # SceneManager's neutral background is compatibility behavior for the one
    # source scene that genuinely has no background, never a production-asset
    # substitute. Guard that source fact so a new omission cannot hide here.
    empty_background_scenes: list[str] = []
    for path in sorted(SCENES_ROOT.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not raw.get("backgrounds"):
            empty_background_scenes.append(str(raw.get("id", path.stem)))
    if empty_background_scenes != ["dev_room"]:
        errors.append(
            "source scenes without backgrounds changed: "
            f"expected=['dev_room'], actual={empty_background_scenes}"
        )

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Temporary bypass audit: PASS (0 pass/TODO/FIXME; source-only placeholder guarded)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
