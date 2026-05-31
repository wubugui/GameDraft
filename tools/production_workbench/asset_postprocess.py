"""Batch post-processing for accepted GPT/Codex asset candidates."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .image_tools import ImageEditOptions, apply_image_edit, resolve_output_path, resolve_source_path

if TYPE_CHECKING:
    from .asset_candidates import AssetCandidate


@dataclass(frozen=True)
class AssetPostprocessOptions:
    output_dir: str = ""
    suffix: str = "_ready"
    output_format: str = "auto"
    resize_width: int | None = None
    resize_height: int | None = None
    keep_aspect: bool = True
    trim_transparent: bool = False
    brightness: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    sharpness: float = 1.0


@dataclass(frozen=True)
class AssetPostprocessItemResult:
    candidate_id: str
    source_path: Path
    output_path: Path | None = None
    ok: bool = False
    message: str = ""
    operations: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AssetPostprocessReport:
    project_root: Path
    total: int
    processed: list[AssetPostprocessItemResult] = field(default_factory=list)
    skipped: list[AssetPostprocessItemResult] = field(default_factory=list)

    @property
    def ok_count(self) -> int:
        return sum(1 for item in self.processed if item.ok)

    @property
    def failed_count(self) -> int:
        return sum(1 for item in self.processed if not item.ok)


def eligible_postprocess_candidates(candidates: list[AssetCandidate]) -> list[AssetCandidate]:
    return [
        item
        for item in candidates
        if item.exists
        and item.review_status != "reject"
        and (item.validation_status == "passed" or item.review_status in {"keep", "accepted"})
    ]


def postprocess_candidates(
    project_root: Path,
    candidates: list[AssetCandidate],
    options: AssetPostprocessOptions,
    *,
    overwrite: bool = False,
) -> AssetPostprocessReport:
    project_root = project_root.resolve()
    processed: list[AssetPostprocessItemResult] = []
    skipped: list[AssetPostprocessItemResult] = []
    eligible_ids = {item.candidate_id for item in eligible_postprocess_candidates(candidates)}

    for candidate in candidates:
        if candidate.candidate_id not in eligible_ids:
            skipped.append(_skip(candidate, _skip_reason(candidate)))
            continue
        try:
            output_path = _candidate_output_path(project_root, candidate, options)
            result = apply_image_edit(
                project_root,
                ImageEditOptions(
                    source_path=str(candidate.resolved_path),
                    output_path=str(output_path),
                    output_format=options.output_format,
                    resize_width=options.resize_width,
                    resize_height=options.resize_height,
                    keep_aspect=options.keep_aspect,
                    trim_transparent=options.trim_transparent,
                    brightness=options.brightness,
                    contrast=options.contrast,
                    saturation=options.saturation,
                    sharpness=options.sharpness,
                ),
                overwrite=overwrite,
            )
            processed.append(
                AssetPostprocessItemResult(
                    candidate_id=candidate.candidate_id,
                    source_path=result.source_path,
                    output_path=result.output_path,
                    ok=True,
                    message="处理完成",
                    operations=result.operations,
                )
            )
        except Exception as exc:  # noqa: BLE001
            processed.append(
                AssetPostprocessItemResult(
                    candidate_id=candidate.candidate_id,
                    source_path=candidate.resolved_path,
                    ok=False,
                    message=str(exc),
                )
            )

    return AssetPostprocessReport(
        project_root=project_root,
        total=len(candidates),
        processed=processed,
        skipped=skipped,
    )


def postprocess_saved_paths(
    project_root: Path,
    saved_paths: list[str],
    options: AssetPostprocessOptions,
    *,
    run_dir: Path | None = None,
    overwrite: bool = False,
) -> AssetPostprocessReport:
    project_root = project_root.resolve()
    processed: list[AssetPostprocessItemResult] = []
    skipped: list[AssetPostprocessItemResult] = []

    for raw_saved in saved_paths:
        saved_path = str(raw_saved or "").strip()
        if not saved_path:
            skipped.append(
                AssetPostprocessItemResult(
                    candidate_id="",
                    source_path=project_root,
                    ok=False,
                    message="savedPath 为空",
                )
            )
            continue
        try:
            source = _resolve_saved_source(project_root, saved_path, run_dir)
            output_path = _source_output_path(project_root, source, options)
            result = apply_image_edit(
                project_root,
                ImageEditOptions(
                    source_path=str(source),
                    output_path=str(output_path),
                    output_format=options.output_format,
                    resize_width=options.resize_width,
                    resize_height=options.resize_height,
                    keep_aspect=options.keep_aspect,
                    trim_transparent=options.trim_transparent,
                    brightness=options.brightness,
                    contrast=options.contrast,
                    saturation=options.saturation,
                    sharpness=options.sharpness,
                ),
                overwrite=overwrite,
            )
            processed.append(
                AssetPostprocessItemResult(
                    candidate_id=saved_path,
                    source_path=result.source_path,
                    output_path=result.output_path,
                    ok=True,
                    message="处理完成",
                    operations=result.operations,
                )
            )
        except Exception as exc:  # noqa: BLE001
            processed.append(
                AssetPostprocessItemResult(
                    candidate_id=saved_path,
                    source_path=Path(saved_path),
                    ok=False,
                    message=str(exc),
                )
            )

    return AssetPostprocessReport(
        project_root=project_root,
        total=len(saved_paths),
        processed=processed,
        skipped=skipped,
    )


def format_asset_postprocess_report(report: AssetPostprocessReport) -> str:
    lines = [
        "素材候选批量后处理",
        f"工程: {report.project_root}",
        f"候选: {report.total}，处理: {len(report.processed)}，成功: {report.ok_count}，失败: {report.failed_count}，跳过: {len(report.skipped)}",
        "",
    ]
    if report.processed:
        lines.append("处理结果:")
        for item in report.processed:
            if item.ok:
                ops = "；".join(item.operations) if item.operations else "复制/格式转换"
                lines.append(f"- [成功] {item.source_path} -> {item.output_path} ({ops})")
            else:
                lines.append(f"- [失败] {item.source_path}: {item.message}")
        lines.append("")
    if report.skipped:
        lines.append("跳过:")
        for item in report.skipped:
            lines.append(f"- {item.source_path}: {item.message}")
    return "\n".join(lines).rstrip()


def _candidate_output_path(
    project_root: Path,
    candidate: AssetCandidate,
    options: AssetPostprocessOptions,
) -> Path:
    suffix = _safe_suffix(options.suffix)
    output_format = (options.output_format or "auto").strip().lower()
    if output_format == "jpg":
        output_format = "jpeg"
    source = candidate.resolved_path
    ext = source.suffix
    if output_format in {"png", "jpeg", "webp"}:
        ext = ".jpg" if output_format == "jpeg" else f".{output_format}"
    filename = f"{source.stem}{suffix}{ext}"
    if options.output_dir.strip():
        raw = str(Path(options.output_dir.strip()) / filename).replace("\\", "/")
    else:
        raw = str(source.with_name(filename))
    return resolve_output_path(project_root, raw, output_format)


def _source_output_path(
    project_root: Path,
    source: Path,
    options: AssetPostprocessOptions,
) -> Path:
    suffix = _safe_suffix(options.suffix)
    output_format = (options.output_format or "auto").strip().lower()
    if output_format == "jpg":
        output_format = "jpeg"
    ext = source.suffix
    if output_format in {"png", "jpeg", "webp"}:
        ext = ".jpg" if output_format == "jpeg" else f".{output_format}"
    filename = f"{source.stem}{suffix}{ext}"
    if options.output_dir.strip():
        raw = str(Path(options.output_dir.strip()) / filename).replace("\\", "/")
    else:
        raw = str(source.with_name(filename))
    return resolve_output_path(project_root, raw, output_format)


def _resolve_saved_source(project_root: Path, saved_path: str, run_dir: Path | None) -> Path:
    try:
        return resolve_source_path(project_root, saved_path)
    except FileNotFoundError:
        if run_dir is None:
            raise
        candidate = (run_dir / saved_path.strip().strip('"')).resolve()
        if candidate.is_file():
            return candidate
        raise


def _safe_suffix(value: str) -> str:
    raw = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in (value or "").strip())
    return raw or "_ready"


def _skip(candidate: AssetCandidate, message: str) -> AssetPostprocessItemResult:
    return AssetPostprocessItemResult(
        candidate_id=candidate.candidate_id,
        source_path=candidate.resolved_path,
        ok=False,
        message=message,
    )


def _skip_reason(candidate: AssetCandidate) -> str:
    if not candidate.exists:
        return "候选文件不存在"
    if candidate.review_status == "reject":
        return "候选已标记废弃"
    if candidate.validation_status == "failed":
        return "自动验收失败，未人工标记保留/采用"
    if candidate.validation_status == "warning":
        return "自动验收警告，未人工标记保留/采用"
    return "未通过自动验收，也未人工标记保留/采用"
