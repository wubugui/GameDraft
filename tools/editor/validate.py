"""Headless full-data validation — the command-line form of the editor's
"Validate Data" menu.

Agent / 策划模式 workflow: after editing JSON directly, run

    python -m tools.editor.validate [project_path] [--strict] [--errors-only]
    ./dev.sh validate-data            # same thing, from the repo root

to get the same cross-data issues the GUI "Validate Data" reports (action-type
registration, cross-file id references, required fields/enums, [tag:…] refs,
deprecated fields, …) without opening the editor. Humans still maintain JSON
through the GUI; only the agent edits JSON directly, so this is the agent's
self-check gate.

This does NOT check media-file existence on disk — that is
``tools.editor.shared.asset_reference_audit`` (run both for full coverage).

Exit codes:
    0  no errors (warnings allowed, unless --strict)
    1  errors found (or warnings when --strict)
    2  bad usage / project failed to load
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .project_model import ProjectModel
from .validator import Issue, validate


def _default_project_root() -> Path:
    # tools/editor/validate.py -> repo root (parent of tools/editor and tools/)
    return Path(__file__).resolve().parent.parent.parent


def run(project_root: Path) -> list[Issue]:
    """Load the project headlessly and return all validation issues.

    Mirrors ``MainWindow._validate`` minus the GUI flush (there are no open
    editors to flush headlessly). ``ProjectModel.load_project`` runs without a
    QApplication — same path used by ``production_workbench.daily_check``.
    """
    model = ProjectModel()
    model.load_project(project_root)
    return validate(model)


def _format(iss: Issue) -> str:
    prefix = "ERR " if iss.severity == "error" else "WARN"
    return f"[{prefix}] [{iss.data_type}] {iss.item_id}: {iss.message}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools.editor.validate",
        description='全量跨数据校验（编辑器 "Validate Data" 的命令行形式）。',
    )
    parser.add_argument(
        "project_path",
        nargs="?",
        default=None,
        help="工程根目录（含 public/assets）。缺省取本仓库根。",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="把 warning 也算失败（exit 1）。",
    )
    parser.add_argument(
        "--errors-only",
        action="store_true",
        help="只打印 error，隐藏 warning。",
    )
    args = parser.parse_args(argv)

    project_root = (
        Path(args.project_path).resolve() if args.project_path else _default_project_root()
    )
    if not (project_root / "public" / "assets").is_dir():
        print(
            f"[validate] 不是有效 GameDraft 工程（缺 public/assets）: {project_root}",
            file=sys.stderr,
        )
        return 2

    try:
        issues = run(project_root)
    except Exception as exc:  # noqa: BLE001 — report load/validate failure, don't traceback-spam
        print(f"[validate] 工程加载/校验失败: {exc}", file=sys.stderr)
        return 2

    errors = [i for i in issues if i.severity == "error"]
    warnings = [i for i in issues if i.severity != "error"]

    # Errors first, then warnings; original order preserved within each group.
    for iss in errors:
        print(_format(iss))
    if not args.errors_only:
        for iss in warnings:
            print(_format(iss))

    print(
        f"[validate] {len(errors)} error(s), {len(warnings)} warning(s).",
        file=sys.stderr,
    )

    if errors:
        return 1
    if args.strict and warnings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
