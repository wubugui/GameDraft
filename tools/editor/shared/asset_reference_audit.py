"""扫描 JSON 中的媒体/文本资源引用，按统一路径策略验证磁盘存在性。

覆盖三个根：

* 媒体字段：必须能通过 :class:`ProjectPaths.url_to_disk` 解析到
  ``public/resources/runtime`` 下，且文件存在。
* 文本配置字段：必须能解析到 ``public/assets`` 下且文件存在。
* 编辑器工程数据：必须能解析到 ``resources/editor_projects`` 下。

提供：

* :func:`audit_project_assets` 仅返回报告，不做修改；
* :func:`format_report` 给出可读输出；
* CLI 入口 ``python -m tools.editor.shared.asset_reference_audit <project_root>``。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from .project_paths import (
    ProjectPaths,
    URL_KIND_MEDIA,
    URL_KIND_TEXT,
)


# --- 字段语义 ------------------------------------------------------------
# 仅在 ``public/assets/{data,scenes,dialogues}`` 树下扫描结构化 JSON；
# 媒体根据键名归类。短名（无前导 / 的相对路径）默认按媒体处理。

_MEDIA_KEY_NAMES = {
    "image",
    "backgroundImage",
    "wheelImage",
    "pointerImage",
    "foregroundImage",
    "spritesheet",
    "atlas",
    "texture",
    "sprite",
    "src",  # audio_config
    "blurredImagePath",
    "clearImagePath",
    "depth_map",
    "collision_map",
    "raw_depth_rg",
    "background.png",
    # overlay 混合叠图动作的图引用（叠图 from/to 是 overlay_images 短名，审查 P2-36）
    "fromImage",
    "toImage",
    # 档案条目插画（ArchiveManager 会预载，审查 P2-36）
    "illustration",
}

# 富文本里 [img:...] 也按媒体短名解析
_RICH_IMG_RE = re.compile(r"\[img:([^\]]+)\]")

_TEXT_KEY_NAMES = {
    "animFile",  # /resources/runtime/animation/<id>/anim.json 实际是 JSON，但运行时与媒体共用 runtime 根
    "animManifest",  # game_config.playerAvatar / setPlayerAvatar 动作的动画包 URL（现网在用，审查 P2-36）
    "manifest",
    "dialogueGraphId",
}


@dataclass
class AssetIssue:
    file: str            # JSON 来源文件，相对项目根
    field_path: str      # 在 JSON 树中的位置
    raw_value: str       # 原始字符串
    reason: str          # 错误原因


@dataclass
class AuditReport:
    project_root: Path
    media_count: int = 0
    text_count: int = 0
    rich_img_count: int = 0
    map_scene_count: int = 0
    overlay_images: dict[str, str] = field(default_factory=dict)
    issues: list[AssetIssue] = field(default_factory=list)
    _issue_keys: set[tuple[str, str, str, str]] = field(default_factory=set, repr=False)

    def add_issue(self, issue: AssetIssue) -> None:
        key = (issue.file, issue.field_path, issue.raw_value, issue.reason)
        if key in self._issue_keys:
            return
        self._issue_keys.add(key)
        self.issues.append(issue)


def _walk_json(value: Any, path: str = "") -> Iterator[tuple[str, str, Any]]:
    """yield (field_path, key_name, value)，遇到非容器节点返回 (path, leaf_key, value)。"""
    if isinstance(value, dict):
        for k, v in value.items():
            child_path = f"{path}.{k}" if path else k
            if isinstance(v, (dict, list)):
                yield from _walk_json(v, child_path)
            else:
                yield child_path, k, v
    elif isinstance(value, list):
        for i, v in enumerate(value):
            child_path = f"{path}[{i}]"
            if isinstance(v, (dict, list)):
                yield from _walk_json(v, child_path)
            else:
                yield child_path, "", v


def _is_media_key(name: str) -> bool:
    return name in _MEDIA_KEY_NAMES


def _is_text_key(name: str) -> bool:
    return name in _TEXT_KEY_NAMES


def _check_media_value(
    paths: ProjectPaths,
    raw: str,
    *,
    file_rel: str,
    field_path: str,
    report: AuditReport,
    scene_id: str | None = None,
) -> None:
    s = raw.strip()
    if not s:
        return
    if s.startswith("http://") or s.startswith("https://"):
        return  # 远端资源不验证
    # showOverlayImage 等动作允许 image 填 overlay_images.json 的短 id。
    if not s.startswith("/") and not s.startswith("resources/") and not s.startswith("assets/"):
        overlay_path = report.overlay_images.get(s)
        if isinstance(overlay_path, str) and overlay_path.strip():
            s = overlay_path.strip()
    # 场景 JSON 内的相对短名按 scene_runtime_dir(scene_id) 解析；
    # 其它情形交给统一 url_to_disk（runtime 根 / 完整 URL / 绝对路径）。
    disk = None
    if scene_id and not s.startswith("/") and not s.startswith("resources/") \
            and not s.startswith("assets/"):
        try:
            disk = paths.scene_runtime_asset(scene_id, s)
        except ValueError:
            disk = None
    if disk is None:
        disk = paths.url_to_disk(s, kind=URL_KIND_MEDIA)
    if disk is None:
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path=field_path,
                raw_value=raw,
                reason="媒体引用不可解析（迁移后必须落到 public/resources/runtime 下；"
                "禁止 /assets/... 媒体）",
            ),
        )
        return
    if not disk.is_file():
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path=field_path,
                raw_value=raw,
                reason=f"媒体文件不存在：{disk}",
            ),
        )


def _check_text_value(
    paths: ProjectPaths,
    raw: str,
    *,
    file_rel: str,
    field_path: str,
    report: AuditReport,
) -> None:
    s = raw.strip()
    if not s:
        return
    if not (s.startswith("/assets/") or s.startswith("assets/") or s.startswith("/resources/runtime/")):
        return
    # animFile 等可能落到 runtime 树（动画 anim.json）
    disk = paths.url_to_disk(s, kind="any")
    if disk is None or not disk.is_file():
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path=field_path,
                raw_value=raw,
                reason=f"配置文件不存在：{disk}",
            ),
        )


def _audit_one_file(
    paths: ProjectPaths,
    json_path: Path,
    *,
    is_text_only: bool,
    report: AuditReport,
    scene_id: str | None = None,
) -> None:
    file_rel = str(json_path.relative_to(paths.project_root)).replace("\\", "/")
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path="",
                raw_value="",
                reason="JSON 解析失败或不可读",
            ),
        )
        return

    for field_path, key, leaf in _walk_json(data):
        if isinstance(leaf, str):
            # 富文本短名：[img:...] 一律按媒体（不带 scene_id，按 runtime 根解析）
            for m in _RICH_IMG_RE.finditer(leaf):
                ref = m.group(1)
                report.rich_img_count += 1
                _check_media_value(
                    paths, ref,
                    file_rel=file_rel,
                    field_path=f"{field_path}#img:{ref}",
                    report=report,
                )

            if _is_media_key(key):
                report.media_count += 1
                _check_media_value(
                    paths, leaf,
                    file_rel=file_rel,
                    field_path=field_path,
                    report=report,
                    scene_id=scene_id,
                )
            elif _is_text_key(key):
                report.text_count += 1
                _check_text_value(
                    paths, leaf,
                    file_rel=file_rel,
                    field_path=field_path,
                    report=report,
                )


def _load_json_for_audit(path: Path, report: AuditReport, paths: ProjectPaths) -> Any | None:
    file_rel = str(path.relative_to(paths.project_root)).replace("\\", "/")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path="",
                raw_value="",
                reason="JSON 解析失败或不可读",
            ),
        )
        return None


def _audit_map_scene_nodes(paths: ProjectPaths, report: AuditReport) -> None:
    """地图节点是运行时可跳转入口；sceneId 必须有场景 JSON 与场景媒体目录。"""
    map_path = paths.data_dir / "map_config.json"
    if not map_path.is_file():
        return
    data = _load_json_for_audit(map_path, report, paths)
    file_rel = str(map_path.relative_to(paths.project_root)).replace("\\", "/")
    if isinstance(data, list):
        nodes = data
        field_prefix = ""
    elif isinstance(data, dict):
        raw_nodes = data.get("nodes")
        if not isinstance(raw_nodes, list):
            report.add_issue(
                AssetIssue(
                    file=file_rel,
                    field_path="nodes",
                    raw_value="",
                    reason="map_config.json 的 nodes 必须是数组",
                ),
            )
            return
        nodes = raw_nodes
        field_prefix = "nodes"
    else:
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path="",
                raw_value="",
                reason="map_config.json 顶层必须是数组或包含 nodes 数组的对象",
            ),
        )
        return

    for idx, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        field_base = f"{field_prefix}[{idx}]" if field_prefix else f"[{idx}]"
        scene_id = str(node.get("sceneId") or "").strip()
        if not scene_id:
            continue
        report.map_scene_count += 1
        try:
            scene_json = paths.scene_json_path(scene_id)
            scene_dir = paths.scene_runtime_dir(scene_id)
        except ValueError as exc:
            report.add_issue(
                AssetIssue(
                    file=file_rel,
                    field_path=f"{field_base}.sceneId",
                    raw_value=scene_id,
                    reason=f"非法地图 sceneId：{exc}",
                ),
            )
            continue
        if not scene_json.is_file():
            report.add_issue(
                AssetIssue(
                    file=file_rel,
                    field_path=f"{field_base}.sceneId",
                    raw_value=scene_id,
                    reason=f"地图场景 JSON 不存在：{scene_json}",
                ),
            )
        if not scene_dir.is_dir():
            report.add_issue(
                AssetIssue(
                    file=file_rel,
                    field_path=f"{field_base}.sceneId",
                    raw_value=scene_id,
                    reason=f"地图场景媒体目录不存在：{scene_dir}",
                ),
            )


def _audit_scene_required_media(paths: ProjectPaths, scene_json: Path, report: AuditReport) -> None:
    data = _load_json_for_audit(scene_json, report, paths)
    if not isinstance(data, dict):
        return

    scene_id = str(data.get("id") or scene_json.stem).strip()
    file_rel = str(scene_json.relative_to(paths.project_root)).replace("\\", "/")
    backgrounds = data.get("backgrounds")
    if isinstance(backgrounds, list) and backgrounds:
        for idx, bg in enumerate(backgrounds):
            if isinstance(bg, dict):
                raw = str(bg.get("image") or "background.png")
                report.media_count += 1
                _check_media_value(
                    paths,
                    raw,
                    file_rel=file_rel,
                    field_path=f"backgrounds[{idx}].image",
                    report=report,
                    scene_id=scene_id,
                )
    elif scene_id != "dev_room":
        report.add_issue(
            AssetIssue(
                file=file_rel,
                field_path="backgrounds",
                raw_value="",
                reason="场景缺少 backgrounds；运行时将只能显示占位背景",
            ),
        )

    depth = data.get("depthConfig")
    if isinstance(depth, dict):
        for key in ("depth_map", "collision_map"):
            raw = str(depth.get(key) or "").strip()
            if not raw:
                report.add_issue(
                    AssetIssue(
                        file=file_rel,
                        field_path=f"depthConfig.{key}",
                        raw_value="",
                        reason="深度配置缺少资源字段",
                    ),
                )
                continue
            report.media_count += 1
            _check_media_value(
                paths,
                raw,
                file_rel=file_rel,
                field_path=f"depthConfig.{key}",
                report=report,
                scene_id=scene_id,
            )


def audit_project_assets(project_root: Path) -> AuditReport:
    paths = ProjectPaths(project_root)
    report = AuditReport(project_root=project_root)

    overlay_path = paths.data_dir / "overlay_images.json"
    if overlay_path.is_file():
        overlay_data = _load_json_for_audit(overlay_path, report, paths)
        if isinstance(overlay_data, dict):
            report.overlay_images = {
                str(k): str(v)
                for k, v in overlay_data.items()
                if isinstance(k, str) and isinstance(v, str)
            }

    _audit_map_scene_nodes(paths, report)

    # data/**/*.json
    if paths.data_dir.is_dir():
        for jp in sorted(paths.data_dir.rglob("*.json")):
            _audit_one_file(paths, jp, is_text_only=False, report=report)

    # scenes/*.json：传入 scene_id（文件名 stem），让短名按 scene_runtime_dir 解析
    if paths.scenes_dir.is_dir():
        for jp in sorted(paths.scenes_dir.glob("*.json")):
            _audit_scene_required_media(paths, jp, report)
            _audit_one_file(
                paths, jp,
                is_text_only=False,
                report=report,
                scene_id=jp.stem,
            )

    # dialogues/graphs/*.json
    dgs = paths.dialogues_dir / "graphs"
    if dgs.is_dir():
        for jp in sorted(dgs.glob("*.json")):
            _audit_one_file(paths, jp, is_text_only=False, report=report)

    return report


def format_report(report: AuditReport, *, max_issues: int = 200) -> str:
    lines = [
        f"[asset_reference_audit] root={report.project_root}",
        f"  scanned media fields: {report.media_count}",
        f"  scanned text fields:  {report.text_count}",
        f"  scanned rich [img:]:  {report.rich_img_count}",
        f"  scanned map scenes:   {report.map_scene_count}",
        f"  issues:               {len(report.issues)}",
    ]
    if not report.issues:
        lines.append("  OK — 所有引用都能通过 ProjectPaths 解析到磁盘文件。")
        return "\n".join(lines)
    head = report.issues[:max_issues]
    for issue in head:
        lines.append(
            f"  - [{issue.file}] {issue.field_path}\n"
            f"      value: {issue.raw_value!r}\n"
            f"      why:   {issue.reason}",
        )
    if len(report.issues) > max_issues:
        lines.append(f"  ... ({len(report.issues) - max_issues} more)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "project_root",
        nargs="?",
        default=".",
        help="GameDraft 仓库根（含 public/、resources/）",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="发现任何 issue 时以非 0 退出，便于在 CI 里 gate。",
    )
    args = parser.parse_args(argv)

    root = Path(args.project_root).resolve()
    report = audit_project_assets(root)
    print(format_report(report))
    if args.strict and report.issues:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
