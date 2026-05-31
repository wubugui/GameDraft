"""Asset style and naming reference sampling for GPT/Codex tasks."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from .asset_audit import AssetRecord, audit_asset_specs


@dataclass(frozen=True)
class AssetStyleSample:
    rel_path: str
    width: int | None
    height: int | None
    image_format: str
    has_alpha: bool | None
    palette: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AssetStyleCategorySummary:
    category: str
    image_count: int
    common_dimensions: list[tuple[str, int]] = field(default_factory=list)
    common_dirs: list[tuple[str, int]] = field(default_factory=list)
    common_name_tokens: list[tuple[str, int]] = field(default_factory=list)
    alpha_count: int = 0
    samples: list[AssetStyleSample] = field(default_factory=list)


@dataclass(frozen=True)
class AssetStyleReferenceReport:
    project_root: Path
    categories: list[AssetStyleCategorySummary] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def build_asset_style_reference(project_root: Path, *, samples_per_category: int = 5) -> AssetStyleReferenceReport:
    project_root = project_root.resolve()
    audit = audit_asset_specs(project_root)
    grouped: dict[str, list[AssetRecord]] = defaultdict(list)
    for image in audit.images:
        grouped[image.category].append(image)

    warnings: list[str] = []
    categories: list[AssetStyleCategorySummary] = []
    for category in sorted(grouped):
        images = sorted(
            grouped[category],
            key=lambda item: (
                item.width is None or item.height is None,
                -item.size_bytes,
                item.rel_path.lower(),
            ),
        )
        dimensions = Counter(
            f"{item.width}x{item.height}"
            for item in images
            if item.width is not None and item.height is not None
        )
        dirs = Counter(str(Path(item.rel_path).parent).replace("\\", "/") for item in images)
        tokens = Counter(token for item in images for token in _name_tokens(Path(item.rel_path).stem))
        samples: list[AssetStyleSample] = []
        for image in images[: max(1, samples_per_category)]:
            palette: list[str] = []
            try:
                palette = _sample_palette(project_root / image.rel_path)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"主色读取失败: {image.rel_path} ({exc})")
            samples.append(
                AssetStyleSample(
                    rel_path=image.rel_path,
                    width=image.width,
                    height=image.height,
                    image_format=image.detected_format or image.ext,
                    has_alpha=image.has_alpha,
                    palette=palette,
                )
            )
        categories.append(
            AssetStyleCategorySummary(
                category=category,
                image_count=len(images),
                common_dimensions=dimensions.most_common(8),
                common_dirs=dirs.most_common(6),
                common_name_tokens=tokens.most_common(10),
                alpha_count=sum(1 for item in images if item.has_alpha is True),
                samples=samples,
            )
        )

    return AssetStyleReferenceReport(project_root=project_root, categories=categories, warnings=warnings)


def format_asset_style_reference_report(report: AssetStyleReferenceReport) -> str:
    lines = [
        "素材风格/命名参考",
        f"工程: {report.project_root}",
        "用途: 复制给 Codex/GPT，作为生成或重抽素材时的项目参考。",
        "",
    ]
    if report.warnings:
        lines.append("警告:")
        lines.extend(f"- {warning}" for warning in report.warnings[:20])
        lines.append("")
    if not report.categories:
        lines.append("没有可抽样的图片素材。")
        return "\n".join(lines)

    for category in report.categories:
        alpha_hint = f"{category.alpha_count}/{category.image_count} 有透明"
        lines.extend([
            f"## {category.category}",
            f"- 图片数: {category.image_count}；透明倾向: {alpha_hint}",
            "- 常见尺寸: " + _format_pairs(category.common_dimensions),
            "- 常见目录: " + _format_pairs(category.common_dirs),
            "- 常见命名词: " + _format_pairs(category.common_name_tokens),
            "- 代表样本:",
        ])
        for sample in category.samples:
            dim = f"{sample.width}x{sample.height}" if sample.width and sample.height else "未知尺寸"
            alpha = "alpha" if sample.has_alpha is True else ("opaque" if sample.has_alpha is False else "alpha未知")
            palette = ", ".join(sample.palette) if sample.palette else "无主色"
            lines.append(
                f"  - {sample.rel_path} | {dim} | {sample.image_format} | {alpha} | palette: {palette}"
            )
        lines.extend([
            "- 给 GPT 的提示: 新图应优先沿用上述目录、尺寸、透明需求、命名词和代表样本气质。",
            "",
        ])
    return "\n".join(lines).rstrip()


def _name_tokens(stem: str) -> list[str]:
    raw = stem.lower()
    tokens = [
        token
        for token in re.split(r"[^0-9a-zA-Z\u4e00-\u9fff]+", raw)
        if len(token) >= 2 and not token.isdigit()
    ]
    return tokens


def _sample_palette(path: Path) -> list[str]:
    with Image.open(path) as source:
        image = source.convert("RGBA")
        image.thumbnail((64, 64), Image.Resampling.LANCZOS)
        buckets: Counter[tuple[int, int, int]] = Counter()
        pixel_data = image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()
        for r, g, b, a in pixel_data:
            if a < 24:
                continue
            buckets[((r // 32) * 32, (g // 32) * 32, (b // 32) * 32)] += 1
    return [f"#{r:02x}{g:02x}{b:02x}" for (r, g, b), _count in buckets.most_common(5)]


def _format_pairs(values: list[tuple[str, int]]) -> str:
    if not values:
        return "无"
    return "；".join(f"{label}({count})" for label, count in values)
