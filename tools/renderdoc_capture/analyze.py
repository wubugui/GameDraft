"""Replay a RenderDoc capture with the Python bundled in qrenderdoc.

The official RenderDoc binary does not ship a standalone ``renderdoc.pyd``.
``qrenderdoc --python`` executes replay_export.py before showing the UI; that
script exits after writing report.json, so no interactive UI is required.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.atomic_io import retry_transient

REQUEST_ENV = "GAMEDRAFT_RENDERDOC_ANALYSIS_REQUEST"
DEFAULT_RENDERDOC_HOME = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "GameDraft" / "RenderDoc" / "1.46" / "portable" / "RenderDoc_1.46_64"


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        retry_transient(os.replace, temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def fail(output: Path, status: str, code: str, message: str, capture: Path | None = None) -> int:
    report = {
        "schemaVersion": 1,
        "status": status,
        "capture": {"path": str(capture)} if capture else None,
        "errors": [{"code": code, "message": message}],
        "unsupported": [],
    }
    write_json(output / "report.json", report)
    print(f"renderdoc analysis {status}: {message}", file=sys.stderr)
    print(str(output / "report.json"))
    return 2 if status == "unsupported" else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a RenderDoc RDC to machine-readable evidence")
    parser.add_argument("--capture", required=True, type=Path, help="absolute .rdc path")
    parser.add_argument("--output", required=True, type=Path, help="analysis directory outside the project")
    parser.add_argument("--renderdoc-path", type=Path, default=DEFAULT_RENDERDOC_HOME,
                        help="RenderDoc installation/portable directory containing qrenderdoc.exe")
    parser.add_argument("--textures", action="store_true", help="save bounded PNG texture samples")
    parser.add_argument("--raw-textures", action="store_true", help="save bounded raw mip-0 texture bytes")
    parser.add_argument("--buffers", action="store_true", help="save bounded raw buffer prefixes")
    parser.add_argument("--texture-id", action="append", default=[], help="select resource ID(s) for texture export")
    parser.add_argument("--buffer-id", action="append", default=[], help="select resource ID(s) for buffer export")
    parser.add_argument("--pixel", action="append", default=[], metavar="RESOURCE_ID:X:Y",
                        help="pixel-history query; use resourceId from report.json")
    parser.add_argument("--max-actions", type=int, default=20000)
    parser.add_argument("--max-pipelines", type=int, default=64)
    parser.add_argument("--max-export-mb", type=int, default=64)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    return parser.parse_args()


def inside_git_checkout(path: Path) -> bool:
    """Reject every worktree, including linked worktrees and resolved junctions."""
    resolved = path.resolve()
    return any((ancestor / ".git").exists() for ancestor in (resolved, *resolved.parents))


def main() -> int:
    args = parse_args()
    capture = args.capture.resolve()
    output = args.output.resolve()
    renderdoc_home = args.renderdoc_path.resolve()
    if inside_git_checkout(output):
        print("renderdoc analysis error: output must be outside every Git checkout/worktree", file=sys.stderr)
        return 1
    if not capture.is_file() or capture.suffix.lower() != ".rdc":
        return fail(output, "error", "capture_missing", "Capture must be an existing .rdc file", capture)
    qrenderdoc = renderdoc_home / ("qrenderdoc.exe" if os.name == "nt" else "qrenderdoc")
    if not qrenderdoc.is_file():
        return fail(output, "unsupported", "renderdoc_unavailable", f"qrenderdoc executable not found: {qrenderdoc}", capture)
    if not 1 <= args.max_actions <= 200000 or not 1 <= args.max_pipelines <= 2048:
        return fail(output, "error", "limit_invalid", "Action/pipeline limits are out of range", capture)
    if not 1 <= args.max_export_mb <= 1024 or not 10 <= args.timeout_seconds <= 1800:
        return fail(output, "error", "limit_invalid", "Export/timeout limits are out of range", capture)
    if len(args.pixel) > 16:
        return fail(output, "error", "pixel_limit", "At most 16 pixel-history queries are supported", capture)
    for spec in args.pixel:
        parts = spec.rsplit(":", 2)
        if len(parts) != 3 or not all(part.isdecimal() for part in parts[1:]):
            return fail(output, "error", "pixel_invalid", f"Expected RESOURCE_ID:X:Y, got {spec!r}", capture)

    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "report.json"
    if report_path.exists():
        report_path.unlink()
    request = {
        "schemaVersion": 1,
        "capture": str(capture),
        "output": str(output),
        "renderdocHome": str(renderdoc_home),
        "repoRoot": str(REPO_ROOT),
        "textures": args.textures,
        "rawTextures": args.raw_textures,
        "buffers": args.buffers,
        "textureIds": args.texture_id,
        "bufferIds": args.buffer_id,
        "pixels": args.pixel,
        "maxActions": args.max_actions,
        "maxPipelines": args.max_pipelines,
        "maxExportBytes": args.max_export_mb * 1024 * 1024,
    }
    request_path = output / "request.json"
    write_json(request_path, request)
    env = os.environ.copy()
    env[REQUEST_ENV] = str(request_path)
    # Qt's "offscreen" platform crashes on the Windows v1.46 portable build.
    # CREATE_NO_WINDOW hides the normal Windows Qt platform instead.
    env.pop("QT_QPA_PLATFORM", None)
    command = [str(qrenderdoc), "--python", str(Path(__file__).with_name("replay_export.py"))]
    try:
        result = subprocess.run(command, cwd=str(renderdoc_home), env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=args.timeout_seconds,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        return fail(output, "error", "analysis_timeout", f"Replay exceeded {args.timeout_seconds} seconds", capture)
    except OSError as exc:
        return fail(output, "unsupported", "renderdoc_launch_failed", str(exc), capture)
    if not report_path.is_file():
        detail = (result.stderr or result.stdout or "no report produced").strip()[-2000:]
        return fail(output, "error", "replay_process_failed", f"qrenderdoc exit {result.returncode}: {detail}", capture)
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return fail(output, "error", "report_invalid", str(exc), capture)
    print(str(report_path))
    return 0 if report.get("status") in ("ok", "partial") else (2 if report.get("status") == "unsupported" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
