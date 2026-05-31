"""Structured GPT asset task records for the production workbench."""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.editor.shared.project_paths import ProjectPaths

from .asset_audit import AssetAuditReport, audit_asset_specs


SCHEMA_VERSION = 1

ASSET_CATEGORIES = [
    "background",
    "scene",
    "character",
    "prop",
    "illustration",
    "minigame",
    "animation",
]

OPERATIONS = [
    "new",
    "redraw",
    "modify",
    "resize",
    "animation_sheet",
]


@dataclass
class AssetTask:
    title: str
    category: str
    operation: str
    request: str
    target_path: str = ""
    output_dir: str = ""
    reference_paths: list[str] = field(default_factory=list)
    width: int | None = None
    height: int | None = None
    transparent: bool | None = None
    frame_count: int | None = None
    style_notes: str = ""
    acceptance: str = ""
    task_id: str = ""
    created_at: str = ""

    def normalized(self) -> "AssetTask":
        category = self.category if self.category in ASSET_CATEGORIES else "illustration"
        operation = self.operation if self.operation in OPERATIONS else "new"
        return AssetTask(
            title=self.title.strip() or "未命名素材任务",
            category=category,
            operation=operation,
            request=self.request.strip(),
            target_path=_normalize_rel(self.target_path),
            output_dir=_normalize_rel(self.output_dir),
            reference_paths=[
                _normalize_rel(x) for x in self.reference_paths if _normalize_rel(x)
            ],
            width=self.width if self.width and self.width > 0 else None,
            height=self.height if self.height and self.height > 0 else None,
            transparent=self.transparent,
            frame_count=self.frame_count if self.frame_count and self.frame_count > 0 else None,
            style_notes=self.style_notes.strip(),
            acceptance=self.acceptance.strip(),
            task_id=self.task_id.strip(),
            created_at=self.created_at.strip(),
        )


def asset_tasks_path(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "production_workbench" / "asset_tasks.jsonl"


def save_asset_task(project_root: Path, task: AssetTask) -> AssetTask:
    normalized = task.normalized()
    if not normalized.task_id:
        normalized.task_id = _new_task_id(normalized.title)
    if not normalized.created_at:
        normalized.created_at = _now_iso()
    path = asset_tasks_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = asset_task_to_dict(normalized)
    payload["prompt"] = build_asset_task_prompt(normalized)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return normalized


def asset_task_to_dict(task: AssetTask) -> dict[str, Any]:
    t = task.normalized()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "taskId": t.task_id,
        "createdAt": t.created_at,
        "title": t.title,
        "category": t.category,
        "operation": t.operation,
        "request": t.request,
        "targetPath": t.target_path,
        "outputDir": t.output_dir,
        "referencePaths": t.reference_paths,
        "width": t.width,
        "height": t.height,
        "transparent": t.transparent,
        "frameCount": t.frame_count,
        "styleNotes": t.style_notes,
        "acceptance": t.acceptance,
    }


def asset_task_from_dict(raw: dict[str, Any]) -> AssetTask:
    refs = raw.get("referencePaths")
    return AssetTask(
        title=str(raw.get("title") or ""),
        category=str(raw.get("category") or "illustration"),
        operation=str(raw.get("operation") or "new"),
        request=str(raw.get("request") or ""),
        target_path=str(raw.get("targetPath") or ""),
        output_dir=str(raw.get("outputDir") or ""),
        reference_paths=[str(x) for x in refs if str(x).strip()] if isinstance(refs, list) else [],
        width=_positive_int_or_none(raw.get("width")),
        height=_positive_int_or_none(raw.get("height")),
        transparent=raw.get("transparent") if isinstance(raw.get("transparent"), bool) else None,
        frame_count=_positive_int_or_none(raw.get("frameCount")),
        style_notes=str(raw.get("styleNotes") or ""),
        acceptance=str(raw.get("acceptance") or ""),
        task_id=str(raw.get("taskId") or ""),
        created_at=str(raw.get("createdAt") or ""),
    ).normalized()


def build_asset_task_prompt(task: AssetTask) -> str:
    t = task.normalized()
    lines = [
        "你是 GameDraft 项目的 GPT 素材制作 agent。请按下面任务生产或修改素材。",
        "",
        "硬性要求:",
        "- 不调用 OpenAI API；使用当前 Codex/GPT agent 可用能力完成。",
        "- 输出必须保存到指定工程路径，文件名和目录不要自作主张改掉。",
        "- 如果需要多次重抽，优先保持构图、风格、尺寸和透明需求稳定。",
        "- 完成后报告输出文件路径、尺寸、是否透明、使用的参考素材和未解决问题。",
        "",
        "任务:",
        f"- 标题: {t.title}",
        f"- 类别: {t.category}",
        f"- 操作: {t.operation}",
        f"- 输出目录: {t.output_dir or default_output_dir(t.category)}",
    ]
    if t.target_path:
        lines.append(f"- 目标文件: {t.target_path}")
    if t.width and t.height:
        lines.append(f"- 目标尺寸: {t.width}x{t.height}")
    if t.transparent is not None:
        lines.append(f"- 透明背景: {'需要' if t.transparent else '不需要'}")
    if t.operation == "animation_sheet" or t.frame_count:
        lines.append(f"- 帧动画 sheet: 需要，帧数 {t.frame_count or '未指定'}")
    if t.reference_paths:
        lines.append("- 参考素材:")
        lines.extend(f"  - {x}" for x in t.reference_paths)
    if t.style_notes:
        lines.extend(["", "风格约束:", t.style_notes])
    lines.extend(["", "具体修改/生成要求:", t.request or "（未填写）"])
    if t.acceptance:
        lines.extend(["", "验收标准:", t.acceptance])
    else:
        lines.extend([
            "",
            "验收标准:",
            "- 尺寸、透明、目录、命名符合任务。",
            "- 风格与参考素材保持同一项目气质。",
            "- 没有明显穿帮、错位、截断、脏边或不该有的文字。",
        ])
    return "\n".join(lines)


def default_output_dir(category: str) -> str:
    return {
        "background": "public/resources/runtime/images/backgrounds",
        "scene": "public/resources/runtime/scenes",
        "character": "public/resources/runtime/images/characters",
        "prop": "public/resources/runtime/images/props",
        "illustration": "public/resources/runtime/images/illustrations",
        "minigame": "public/resources/runtime/images/minigames",
        "animation": "public/resources/runtime/animation",
    }.get(category, "public/resources/runtime/images/illustrations")


def suggest_task_defaults(
    project_root: Path,
    category: str,
    *,
    report: AssetAuditReport | None = None,
) -> dict[str, Any]:
    report = report or audit_asset_specs(project_root)
    images = [x for x in report.images if x.category == category]
    dims = Counter(
        (x.width, x.height)
        for x in images
        if x.width is not None and x.height is not None
    )
    width: int | None = None
    height: int | None = None
    if dims:
        (width, height), _count = dims.most_common(1)[0]
    alpha_votes = [x.has_alpha for x in images if x.has_alpha is not None]
    transparent = None
    if alpha_votes:
        transparent = alpha_votes.count(True) >= alpha_votes.count(False)
    refs = [
        x.rel_path for x in sorted(images, key=lambda item: item.size_bytes, reverse=True)[:5]
    ]
    return {
        "outputDir": default_output_dir(category),
        "width": width,
        "height": height,
        "transparent": transparent,
        "referencePaths": refs,
    }


def _normalize_rel(value: str) -> str:
    raw = (value or "").strip().replace("\\", "/")
    raw = raw.lstrip("/")
    if not raw:
        return ""
    parts = [p for p in raw.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        return ""
    return "/".join(parts)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _new_task_id(title: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", title.strip()).strip("-")
    return f"asset-{stamp}-{slug[:32] or 'task'}"


def _positive_int_or_none(value: Any) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None
