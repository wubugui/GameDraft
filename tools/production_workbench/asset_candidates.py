"""Candidate assets produced by Codex/GPT asset task runs."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.editor.shared.project_paths import ProjectPaths

from .asset_output_validation import AssetOutputValidationReport, validate_codex_run_summary
from .asset_tasks import AssetTask, save_asset_task
from .codex_asset_runner import asset_task_runs_root
from .image_tools import inspect_image


REVIEW_STATUSES = ["unreviewed", "keep", "reject", "accepted"]


@dataclass(frozen=True)
class AssetCandidateReview:
    status: str = "unreviewed"
    note: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class AssetCandidate:
    candidate_id: str
    task_id: str
    run_dir: Path
    saved_path: str
    resolved_path: Path
    display_path: str
    exists: bool
    width: int | None = None
    height: int | None = None
    image_format: str = ""
    has_alpha: bool | None = None
    message: str = ""
    validation_status: str = "not_checked"
    validation_label: str = "未验收"
    validation_message: str = ""
    review_status: str = "unreviewed"
    review_note: str = ""
    review_updated_at: str = ""


@dataclass(frozen=True)
class AssetCandidateReport:
    project_root: Path
    candidates: list[AssetCandidate] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def existing_count(self) -> int:
        return sum(1 for item in self.candidates if item.exists)

    @property
    def missing_count(self) -> int:
        return sum(1 for item in self.candidates if not item.exists)


@dataclass(frozen=True)
class AssetCandidateRedrawTaskItem:
    candidate_id: str
    display_path: str
    task_id: str = ""
    title: str = ""
    ok: bool = False
    message: str = ""


@dataclass(frozen=True)
class AssetCandidateRedrawTaskReport:
    project_root: Path
    created: list[AssetCandidateRedrawTaskItem] = field(default_factory=list)
    skipped: list[AssetCandidateRedrawTaskItem] = field(default_factory=list)

    @property
    def created_count(self) -> int:
        return len(self.created)

    @property
    def skipped_count(self) -> int:
        return len(self.skipped)


@dataclass(frozen=True)
class AssetCandidateScoreItem:
    candidate_id: str
    display_path: str
    score: int
    label: str
    recommendation: str
    reasons: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AssetCandidateScoreReport:
    project_root: Path
    items: list[AssetCandidateScoreItem] = field(default_factory=list)

    @property
    def top_ready_count(self) -> int:
        return sum(1 for item in self.items if item.score >= 80)

    @property
    def needs_review_count(self) -> int:
        return sum(1 for item in self.items if 50 <= item.score < 80)

    @property
    def redraw_count(self) -> int:
        return sum(1 for item in self.items if item.score < 50)


def list_asset_candidates(project_root: Path) -> AssetCandidateReport:
    project_root = project_root.resolve()
    root = asset_task_runs_root(project_root)
    warnings: list[str] = []
    candidates: list[AssetCandidate] = []
    reviews = load_candidate_reviews(project_root)
    if not root.is_dir():
        return AssetCandidateReport(project_root=project_root, warnings=["还没有 Codex 素材任务运行记录。"])

    for summary_path in sorted(root.glob("*/summary.json"), reverse=True):
        try:
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            warnings.append(f"读取失败: {summary_path} ({exc})")
            continue
        task_id = str(payload.get("taskId") or summary_path.parent.name).strip()
        summary = payload.get("eventSummary") if isinstance(payload.get("eventSummary"), dict) else {}
        saved_paths = summary.get("savedPaths") if isinstance(summary.get("savedPaths"), list) else []
        if not saved_paths:
            continue
        validation = _validation_by_saved_path(project_root, summary_path, warnings)
        for raw_saved in saved_paths:
            saved_path = str(raw_saved or "").strip()
            if not saved_path:
                continue
            candidates.append(
                _candidate_from_saved_path(
                    project_root,
                    summary_path.parent,
                    task_id,
                    saved_path,
                    reviews,
                    validation.get(_normalized_saved_path(saved_path), _CandidateValidation()),
                )
            )

    return AssetCandidateReport(project_root=project_root, candidates=candidates, warnings=warnings)


def format_asset_candidate_report(report: AssetCandidateReport) -> str:
    lines = [
        "素材候选版本",
        f"工程: {report.project_root}",
        f"候选: {len(report.candidates)}，存在: {report.existing_count}，缺失: {report.missing_count}",
        "",
    ]
    if report.warnings:
        lines.append("警告:")
        lines.extend(f"- {item}" for item in report.warnings)
        lines.append("")
    if not report.candidates:
        lines.append("没有候选。先在“素材任务”里执行 Codex 并记录，或确认 Codex 输出了 savedPath。")
        return "\n".join(lines)

    for item in report.candidates:
        size = f"{item.width}x{item.height}" if item.width and item.height else "未知尺寸"
        alpha = "透明" if item.has_alpha is True else ("不透明" if item.has_alpha is False else "未知透明")
        status = "存在" if item.exists else "缺失"
        review = review_status_label(item.review_status)
        lines.append(
            f"- [{status}/{item.validation_label}/{review}] "
            f"{item.display_path} | {size} | {alpha} | task={item.task_id}"
        )
        if item.validation_message:
            lines.append(f"  自动验收: {item.validation_message}")
        if item.message:
            lines.append(f"  说明: {item.message}")
        if item.review_note:
            lines.append(f"  评审备注: {item.review_note}")
    return "\n".join(lines)


def asset_candidate_reviews_path(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "production_workbench" / "asset_candidate_reviews.json"


def load_candidate_reviews(project_root: Path) -> dict[str, AssetCandidateReview]:
    path = asset_candidate_reviews_path(project_root)
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    raw_items = payload.get("candidates") if isinstance(payload, dict) else None
    if not isinstance(raw_items, dict):
        return {}
    out: dict[str, AssetCandidateReview] = {}
    for candidate_id, raw in raw_items.items():
        if not isinstance(raw, dict):
            continue
        status = str(raw.get("status") or "unreviewed").strip()
        if status not in REVIEW_STATUSES:
            status = "unreviewed"
        out[str(candidate_id)] = AssetCandidateReview(
            status=status,
            note=str(raw.get("note") or "").strip(),
            updated_at=str(raw.get("updatedAt") or "").strip(),
        )
    return out


def save_candidate_review(
    project_root: Path,
    candidate_id: str,
    *,
    status: str,
    note: str = "",
) -> Path:
    clean_id = candidate_id.strip()
    if not clean_id:
        raise ValueError("candidate_id 不能为空。")
    clean_status = status.strip()
    if clean_status not in REVIEW_STATUSES:
        raise ValueError(f"未知候选评审状态: {status}")
    reviews = load_candidate_reviews(project_root)
    reviews[clean_id] = AssetCandidateReview(
        status=clean_status,
        note=note.strip(),
        updated_at=_now_iso(),
    )
    path = asset_candidate_reviews_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "candidates": {
            key: {
                "status": value.status,
                "note": value.note,
                "updatedAt": value.updated_at,
            }
            for key, value in sorted(reviews.items())
        },
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def review_status_label(status: str) -> str:
    return {
        "unreviewed": "未评审",
        "keep": "保留",
        "reject": "废弃",
        "accepted": "采用",
    }.get(status, "未评审")


def build_redraw_task_from_candidate(candidate: AssetCandidate, request: str = "") -> AssetTask:
    note = request.strip() or candidate.review_note.strip()
    if not note:
        note = "保留当前候选的构图、风格和识别度，修正明显问题后重抽一版。"
    category = _infer_category(candidate.display_path)
    return AssetTask(
        title=f"重抽/修改 {Path(candidate.display_path).stem or candidate.task_id}",
        category=category,
        operation="redraw",
        request=(
            "基于下面候选继续修改，不要从零随机换风格。\n"
            f"候选文件: {candidate.display_path}\n"
            f"修改要求: {note}"
        ),
        target_path=candidate.display_path,
        output_dir=_parent_dir(candidate.display_path) or _default_candidate_output_dir(category),
        reference_paths=[candidate.display_path] if candidate.exists else [],
        width=candidate.width,
        height=candidate.height,
        transparent=candidate.has_alpha,
        style_notes="沿用候选图的项目风格、边缘处理、透明/白底要求和构图比例。",
        acceptance=(
            "输出路径、尺寸、透明需求与任务一致；"
            "保留候选优点；明确修正备注中指出的问题；"
            "没有脏边、截断、错误文字或风格突变。"
        ),
    )


def batch_create_redraw_tasks(
    project_root: Path,
    candidates: list[AssetCandidate],
    *,
    request: str = "",
) -> AssetCandidateRedrawTaskReport:
    created: list[AssetCandidateRedrawTaskItem] = []
    skipped: list[AssetCandidateRedrawTaskItem] = []
    for candidate in candidates:
        reason = redraw_eligibility_reason(candidate)
        if reason:
            skipped.append(
                AssetCandidateRedrawTaskItem(
                    candidate_id=candidate.candidate_id,
                    display_path=candidate.display_path,
                    ok=False,
                    message=reason,
                )
            )
            continue
        try:
            task_request = request.strip() or candidate.review_note.strip() or candidate.validation_message.strip()
            task = save_asset_task(project_root, build_redraw_task_from_candidate(candidate, task_request))
            created.append(
                AssetCandidateRedrawTaskItem(
                    candidate_id=candidate.candidate_id,
                    display_path=candidate.display_path,
                    task_id=task.task_id,
                    title=task.title,
                    ok=True,
                    message="已创建 redraw 任务单",
                )
            )
        except Exception as exc:  # noqa: BLE001
            skipped.append(
                AssetCandidateRedrawTaskItem(
                    candidate_id=candidate.candidate_id,
                    display_path=candidate.display_path,
                    ok=False,
                    message=f"创建失败: {exc}",
                )
            )
    return AssetCandidateRedrawTaskReport(project_root=project_root.resolve(), created=created, skipped=skipped)


def redraw_eligibility_reason(candidate: AssetCandidate) -> str:
    if not candidate.exists:
        return "候选文件不存在，不能作为重抽参考"
    if candidate.review_status == "accepted":
        return "候选已采用，默认不再重抽"
    if candidate.review_status in {"keep", "reject"}:
        return ""
    if candidate.validation_status in {"failed", "warning"}:
        return ""
    return "未人工标记保留/废弃，自动验收也未失败/警告"


def format_asset_candidate_redraw_task_report(report: AssetCandidateRedrawTaskReport) -> str:
    lines = [
        "素材候选批量重抽任务",
        f"工程: {report.project_root}",
        f"创建: {report.created_count}，跳过: {report.skipped_count}",
        "",
    ]
    if report.created:
        lines.append("已创建:")
        for item in report.created:
            lines.append(f"- {item.display_path} -> {item.title} ({item.task_id})")
        lines.append("")
    if report.skipped:
        lines.append("跳过:")
        for item in report.skipped:
            lines.append(f"- {item.display_path}: {item.message}")
    return "\n".join(lines).rstrip()


def score_asset_candidates(project_root: Path, candidates: list[AssetCandidate]) -> AssetCandidateScoreReport:
    items = [score_asset_candidate(candidate) for candidate in candidates]
    items.sort(key=lambda item: (-item.score, item.display_path.lower()))
    return AssetCandidateScoreReport(project_root=project_root.resolve(), items=items)


def score_asset_candidate(candidate: AssetCandidate) -> AssetCandidateScoreItem:
    score = 40
    reasons: list[str] = []

    if not candidate.exists:
        return AssetCandidateScoreItem(
            candidate_id=candidate.candidate_id,
            display_path=candidate.display_path,
            score=0,
            label="缺失",
            recommendation="不能交付；先重跑 Codex 或检查 savedPath。",
            reasons=["文件不存在"],
        )

    score += 10
    reasons.append("文件存在")

    if candidate.validation_status == "passed":
        score += 25
        reasons.append("自动验收通过")
    elif candidate.validation_status == "warning":
        score += 5
        reasons.append("自动验收警告")
    elif candidate.validation_status == "failed":
        score -= 25
        reasons.append("自动验收失败")
    else:
        reasons.append("未做自动验收")

    if candidate.review_status == "accepted":
        score += 25
        reasons.append("人工标记采用")
    elif candidate.review_status == "keep":
        score += 15
        reasons.append("人工标记保留")
    elif candidate.review_status == "reject":
        score -= 35
        reasons.append("人工标记废弃")
    else:
        reasons.append("未人工评审")

    if candidate.width and candidate.height:
        score += 5
        reasons.append(f"尺寸可读 {candidate.width}x{candidate.height}")
    else:
        score -= 10
        reasons.append("尺寸不可读")

    if candidate.has_alpha is not None:
        score += 3
        reasons.append("透明信息可读")
    if candidate.message:
        score -= 8
        reasons.append(candidate.message)

    score = max(0, min(100, score))
    label, recommendation = _score_label_and_recommendation(score)
    return AssetCandidateScoreItem(
        candidate_id=candidate.candidate_id,
        display_path=candidate.display_path,
        score=score,
        label=label,
        recommendation=recommendation,
        reasons=reasons,
    )


def format_asset_candidate_score_report(report: AssetCandidateScoreReport) -> str:
    lines = [
        "素材候选交付评分（规则）",
        f"工程: {report.project_root}",
        (
            f"候选: {len(report.items)}，优先交付: {report.top_ready_count}，"
            f"需人工快审: {report.needs_review_count}，建议重抽/阻塞: {report.redraw_count}"
        ),
        "说明: 评分只基于文件存在、自动验收、人工评审、尺寸/透明信息；不判断美术质量。",
        "",
    ]
    if not report.items:
        lines.append("没有候选可评分。")
        return "\n".join(lines)
    for item in report.items:
        lines.append(f"- [{item.score:03d} {item.label}] {item.display_path}")
        lines.append(f"  建议: {item.recommendation}")
        if item.reasons:
            lines.append("  依据: " + "；".join(item.reasons))
    return "\n".join(lines)


def _candidate_from_saved_path(
    project_root: Path,
    run_dir: Path,
    task_id: str,
    saved_path: str,
    reviews: dict[str, AssetCandidateReview],
    validation: "_CandidateValidation",
) -> AssetCandidate:
    candidate_id = _candidate_id(run_dir, saved_path)
    review = reviews.get(candidate_id, AssetCandidateReview())
    resolved = _resolve_saved_path(project_root, run_dir, saved_path)
    display = _display_path(project_root, resolved, fallback=saved_path)
    if not resolved.is_file():
        return AssetCandidate(
            candidate_id=candidate_id,
            task_id=task_id,
            run_dir=run_dir,
            saved_path=saved_path,
            resolved_path=resolved,
            display_path=display,
            exists=False,
            message="文件不存在；可能是 Codex 只报告了计划路径，或生成失败。",
            validation_status=validation.status,
            validation_label=validation.label,
            validation_message=validation.message,
            review_status=review.status,
            review_note=review.note,
            review_updated_at=review.updated_at,
        )
    try:
        info = inspect_image(resolved)
    except Exception as exc:  # noqa: BLE001
        return AssetCandidate(
            candidate_id=candidate_id,
            task_id=task_id,
            run_dir=run_dir,
            saved_path=saved_path,
            resolved_path=resolved,
            display_path=display,
            exists=True,
            message=f"存在但不是可识别图片: {exc}",
            validation_status=validation.status,
            validation_label=validation.label,
            validation_message=validation.message,
            review_status=review.status,
            review_note=review.note,
            review_updated_at=review.updated_at,
        )
    return AssetCandidate(
        candidate_id=candidate_id,
        task_id=task_id,
        run_dir=run_dir,
        saved_path=saved_path,
        resolved_path=resolved,
        display_path=display,
        exists=True,
        width=info.width,
        height=info.height,
        image_format=info.detected_format,
        has_alpha=info.has_alpha,
        validation_status=validation.status,
        validation_label=validation.label,
        validation_message=validation.message,
        review_status=review.status,
        review_note=review.note,
        review_updated_at=review.updated_at,
    )


@dataclass(frozen=True)
class _CandidateValidation:
    status: str = "not_checked"
    label: str = "未验收"
    message: str = ""


def _validation_by_saved_path(
    project_root: Path,
    summary_path: Path,
    warnings: list[str],
) -> dict[str, _CandidateValidation]:
    if not _summary_has_task_snapshot(summary_path):
        return {}
    try:
        report = validate_codex_run_summary(project_root, summary_path)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"自动验收读取失败: {summary_path} ({exc})")
        return {}
    mapped: dict[str, _CandidateValidation] = {}
    global_issues = [issue for issue in report.issues if not issue.path]
    for item in report.items:
        key = _normalized_saved_path(item.saved_path)
        issues = [
            issue
            for issue in report.issues
            if _normalized_saved_path(issue.path) == key
        ]
        mapped[key] = _candidate_validation_from_issues(report, issues + global_issues)
    return mapped


def _summary_has_task_snapshot(summary_path: Path) -> bool:
    try:
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(payload.get("task"), dict)


def _candidate_validation_from_issues(
    report: AssetOutputValidationReport,
    issues: list[Any],
) -> _CandidateValidation:
    if any(issue.severity == "error" for issue in issues):
        return _CandidateValidation("failed", "验收失败", _join_issue_messages(issues, "error"))
    if any(issue.severity == "warning" for issue in issues):
        return _CandidateValidation("warning", "验收警告", _join_issue_messages(issues, "warning"))
    if report.ok:
        return _CandidateValidation("passed", "验收通过", "尺寸、透明和 sheet 基础规格符合任务。")
    return _CandidateValidation("passed", "验收通过", "该输出文件未发现问题。")


def _join_issue_messages(issues: list[Any], severity: str) -> str:
    messages = [
        str(issue.message).strip()
        for issue in issues
        if issue.severity == severity and str(issue.message).strip()
    ]
    return "；".join(messages) if messages else severity


def _resolve_saved_path(project_root: Path, run_dir: Path, saved_path: str) -> Path:
    raw = saved_path.strip().strip('"')
    path = Path(raw)
    if path.is_absolute():
        return path.resolve()
    project_candidate = (project_root / raw).resolve()
    if project_candidate.exists():
        return project_candidate
    run_candidate = (run_dir / raw).resolve()
    if run_candidate.exists():
        return run_candidate
    return project_candidate


def _normalized_saved_path(value: str) -> str:
    return value.strip().strip('"').replace("\\", "/")


def _display_path(project_root: Path, path: Path, *, fallback: str) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return fallback


def _candidate_id(run_dir: Path, saved_path: str) -> str:
    clean_saved = saved_path.strip().replace("\\", "/")
    return f"{run_dir.name}|{clean_saved}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _infer_category(path: str) -> str:
    text = path.replace("\\", "/").lower()
    if "/background" in text or "/backgrounds" in text:
        return "background"
    if "/scene" in text or "/scenes" in text:
        return "scene"
    if "/character" in text or "/characters" in text:
        return "character"
    if "/prop" in text or "/props" in text:
        return "prop"
    if "/minigame" in text or "/minigames" in text:
        return "minigame"
    if "/animation" in text:
        return "animation"
    return "illustration"


def _parent_dir(path: str) -> str:
    parent = Path(path.replace("\\", "/")).parent
    text = parent.as_posix()
    return "" if text == "." else text


def _default_candidate_output_dir(category: str) -> str:
    return {
        "background": "public/resources/runtime/images/backgrounds",
        "scene": "public/resources/runtime/scenes",
        "character": "public/resources/runtime/images/characters",
        "prop": "public/resources/runtime/images/props",
        "illustration": "public/resources/runtime/images/illustrations",
        "minigame": "public/resources/runtime/images/minigames",
        "animation": "public/resources/runtime/animation",
    }.get(category, "public/resources/runtime/images/illustrations")


def _score_label_and_recommendation(score: int) -> tuple[str, str]:
    if score >= 85:
        return "可交付", "优先进入后处理或采用流程；仍需人工看图确认。"
    if score >= 70:
        return "可保留", "建议人工快审；通过后可后处理。"
    if score >= 50:
        return "需确认", "需要人工确认问题；必要时创建重抽任务。"
    if score >= 25:
        return "建议重抽", "优先写备注并创建 redraw 任务。"
    return "阻塞", "不建议继续使用；先修 savedPath、重跑或重抽。"
