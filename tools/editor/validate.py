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


def _json_lang_issues(project_root: Path) -> list[Issue]:
    """json_lang 咨询层并入收尾门:schema 全量校验(悬垂 id/未登记 flag 等
    validator 盲区)记 warning;对话图连边 lint(悬垂连边/悬垂外部入口)记 error、
    不可达节点记 warning。json_lang 自身故障降级为一条 warning,不拦内容工作。"""
    out: list[Issue] = []
    try:
        from tools.json_lang.build import _rebuild, _validate_all
        from tools.json_lang.lint import lint_dialogue_graphs

        schema = _rebuild(project_root)["schema"]
        for problem in _validate_all(schema, project_root):
            severity = "warning"
            if problem.startswith("(跳过"):
                out.append(Issue("warning", "json-lang", "schema", problem))
                continue
            out.append(Issue(severity, "json-lang", "schema", problem))
        for it in lint_dialogue_graphs(project_root):
            out.append(Issue(it.severity, "json-lang", it.file, it.message))
    except Exception as exc:  # noqa: BLE001 — 咨询层坏了不应挡住权威校验
        out.append(Issue("warning", "json-lang", "self", f"json_lang 检查未能运行: {exc}"))
    return out


def _lighting_payload_issues(project_root: Path) -> list[Issue]:
    """角色照明烘焙载荷防腐门(character_lighting_lab 导出物,P1 数据通道)。

    只对存在 lighting/ 目录的场景生效:①lighting.json 结构齐全;②三份 probe bin
    与 ground_d.png 在盘且尺寸吻合 probe 网格;③背景内容哈希一致——背景重画而
    烘焙未跟上时记 error(运行时同样会据此禁用,防"静默过期"照明)。"""
    import hashlib
    import json as _json

    out: list[Issue] = []
    scenes_dir = project_root / "public" / "resources" / "runtime" / "scenes"
    if not scenes_dir.is_dir():
        return out
    required = {"version", "background_sha1", "work", "cal", "world",
                "probes", "ambient_sh", "lights", "ground_d"}
    for lj in sorted(scenes_dir.glob("*/lighting/lighting.json")):
        scene = lj.parent.parent.name
        tag = f"scenes/{scene}/lighting"
        try:
            payload = _json.loads(lj.read_text())
        except Exception as exc:  # noqa: BLE001
            out.append(Issue("error", "lighting-bake", tag, f"lighting.json 解析失败: {exc}"))
            continue
        missing = required - set(payload)
        if missing:
            out.append(Issue("error", "lighting-bake", tag, f"lighting.json 缺字段: {sorted(missing)}"))
            continue
        pr = payload["probes"]
        pn = int(pr.get("nx", 0)) * int(pr.get("ny", 0)) * int(pr.get("nz", 0))
        expect = {"probes_l2.bin": pn * 9 * 4 * 2,
                  "probes_l2amb.bin": pn * 9 * 3 * 2,
                  "probes_l2nee.bin": pn * 9 * 3 * 2}
        for fname, size in expect.items():
            f = lj.parent / fname
            if not f.exists():
                out.append(Issue("error", "lighting-bake", tag, f"缺文件 {fname}"))
            elif pn and f.stat().st_size != size:
                out.append(Issue("error", "lighting-bake", tag,
                                 f"{fname} 尺寸 {f.stat().st_size} != 期望 {size}(probe 网格不匹配)"))
        if not (lj.parent / "ground_d.png").exists():
            out.append(Issue("error", "lighting-bake", tag, "缺文件 ground_d.png"))
        bg = lj.parent.parent / "background.png"
        if not bg.exists():
            out.append(Issue("error", "lighting-bake", tag, "场景缺 background.png"))
        else:
            h = hashlib.sha1(bg.read_bytes()).hexdigest()[:12]
            if h != payload["background_sha1"]:
                out.append(Issue("error", "lighting-bake", tag,
                                 f"背景内容哈希失配(烘焙 {payload['background_sha1']} vs 现况 {h})"
                                 "——背景已重画,需在角色照明实验室重烘并重新导出"))
    return out


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

    issues.extend(_json_lang_issues(project_root))
    issues.extend(_lighting_payload_issues(project_root))

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
