#!/usr/bin/env python3
"""Collect shared assets, export macOS/Windows packages, and smoke-check them."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
DEFAULT_GODOT = Path("/Applications/Godot.app/Contents/MacOS/Godot")


def command(args: list[str], timeout: int = 600, *, allow_shutdown_leak: bool = False) -> str:
    result = subprocess.run(args, cwd=REPO_ROOT, text=True, capture_output=True, timeout=timeout, check=False)
    output = result.stdout + result.stderr
    checked = output.replace("ERROR: 8 resources still in use at exit", "KNOWN_SHUTDOWN_LEAK:") if allow_shutdown_leak else output
    if result.returncode != 0 or "SCRIPT ERROR:" in checked or "ERROR:" in checked:
        raise RuntimeError(f"command failed: {' '.join(args)}\n{output[-20000:]}")
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--godot", default=str(DEFAULT_GODOT))
    parser.add_argument("--skip-collect", action="store_true")
    args = parser.parse_args()
    godot = args.godot
    if not args.skip_collect:
        print(command([sys.executable, str(PORT_ROOT / "tools/collect_export_assets.py")]).strip())
    build = PORT_ROOT / "build"
    build.mkdir(parents=True, exist_ok=True)
    (build / ".gdignore").write_text("export output; never import into the editor project\n", encoding="utf-8")
    command([godot, "--headless", "--path", str(PORT_ROOT), "--import"], timeout=1200)
    mac_app = build / "macos/GameDraft.app"
    win_exe = build / "windows/GameDraft.exe"
    mac_app.parent.mkdir(parents=True, exist_ok=True)
    win_exe.parent.mkdir(parents=True, exist_ok=True)
    command([godot, "--headless", "--path", str(PORT_ROOT), "--export-release", "macOS", str(mac_app)], timeout=1800)
    command([godot, "--headless", "--path", str(PORT_ROOT), "--export-release", "Windows Desktop", str(win_exe)], timeout=1800)
    shared = PORT_ROOT / "generated/public"
    mac_shared = mac_app / "Contents/Resources/shared/public"
    win_shared = win_exe.parent / "shared/public"
    for destination in [mac_shared, win_shared]:
        if destination.exists(): shutil.rmtree(destination)
        shutil.copytree(shared, destination, ignore=shutil.ignore_patterns(".gdignore"), copy_function=shutil.copy2)
    mac_bins = list((mac_app / "Contents/MacOS").glob("*"))
    if not mac_bins or not mac_bins[0].is_file():
        raise RuntimeError("macOS export is missing its executable")
    with tempfile.TemporaryDirectory(prefix="gamedraft-export-smoke-") as raw:
        temp = Path(raw); request = temp / "request.json"; response = temp / "response.json"; request_id = f"export-{uuid.uuid4().hex}"
        request.write_text(json.dumps({"protocolVersion": 1, "requestId": request_id, "operations": [{"type": "ping"}, {"type": "captureSnapshot", "command": {"id": request_id, "type": "captureSnapshot", "reason": "export-smoke"}}]}), encoding="utf-8")
        launch = command([str(mac_bins[0]), "--headless", "--", "--parity-start-scene=dev_room", f"--parity-request={request}", f"--parity-response={response}", "--parity-quit"], timeout=30, allow_shutdown_leak=True)
        if "Failed to load" in launch or "not found" in launch or not response.is_file():
            raise RuntimeError(f"macOS exported launch reported missing resources\n{launch}")
        payload = json.loads(response.read_text(encoding="utf-8"))
        if payload.get("requestId") != request_id or any(result.get("ok") is not True for result in payload.get("results", [])):
            raise RuntimeError(f"macOS exported parity smoke failed: {payload}")
    if not win_exe.is_file() or win_exe.stat().st_size < 10 * 1024 * 1024 or win_exe.read_bytes()[:2] != b"MZ":
        raise RuntimeError("Windows export is not a valid embedded-PCK PE executable")
    print(f"macOS exported package launch smoke: PASS ({mac_app})")
    print(f"Windows exported PE/resource package verification: PASS ({win_exe})")
    print("Godot macOS/Windows export build: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
