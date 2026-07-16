#!/usr/bin/env python3
"""Prove Godot -> TypeScript -> Godot save interoperability with real managers."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
DEFAULT_GODOT = Path("/Applications/Godot.app/Contents/MacOS/Godot")


def run(command: list[str], marker: str, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, env=env, timeout=90, check=False)
    output = result.stdout + result.stderr
    if result.returncode != 0 or marker not in output or "SCRIPT ERROR:" in output or "ERROR:" in output:
        raise RuntimeError(f"save interop command failed: {' '.join(command)}\n{output[-12000:]}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--godot", default=str(DEFAULT_GODOT))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="gamedraft-save-interop-") as raw:
        root = Path(raw)
        godot_seed = root / "godot-seed.json"
        ts_output = root / "typescript-output.json"
        godot_final = root / "godot-final.json"
        scene = "res://tests/save_interop_shell_probe.tscn"
        run([args.godot, "--headless", "--path", str(PORT_ROOT), "--scene", scene, "--", "--phase=produce", f"--output={godot_seed}", f"--storage={root / 'producer'}"], "Godot save interop producer: PASS")
        env = os.environ.copy()
        env["GAMEDRAFT_SAVE_INTEROP_INPUT"] = str(godot_seed)
        env["GAMEDRAFT_SAVE_INTEROP_OUTPUT"] = str(ts_output)
        run(["npx", "vitest", "run", "godot_port/tools/save_interop_probe.test.ts"], "1 passed", env)
        run([args.godot, "--headless", "--path", str(PORT_ROOT), "--scene", scene, "--", "--phase=consume", f"--input={ts_output}", f"--output={godot_final}", f"--storage={root / 'consumer'}"], "Godot save interop consumer: PASS")
        seed = json.loads(godot_seed.read_text(encoding="utf-8"))
        final = json.loads(godot_final.read_text(encoding="utf-8"))
        if seed.get("version") != final.get("version") or final.get("systems", {}).get("flagStore", {}).get("archive_book_book_erta_guide") is not False:
            raise RuntimeError("save interop final payload lost version or TypeScript flag mutation")
        missing = sorted(set(seed.get("systems", {})) - set(final.get("systems", {})))
        if missing:
            raise RuntimeError(f"save interop final payload lost system buckets: {missing}")
    print("TypeScript→Godot→TypeScript→Godot bidirectional save E2E: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
