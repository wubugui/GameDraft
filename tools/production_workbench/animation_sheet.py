"""Animation sheet inspection, splitting and composing for production assets."""
from __future__ import annotations

from dataclasses import dataclass, field
from math import ceil
from pathlib import Path

from PIL import Image

from .image_tools import inspect_image, resolve_output_path, resolve_source_path


@dataclass(frozen=True)
class SheetGridOptions:
    source_path: str
    frame_count: int | None = None
    columns: int | None = None
    rows: int | None = None
    frame_width: int | None = None
    frame_height: int | None = None


@dataclass(frozen=True)
class AnimationSheetReport:
    source_path: Path
    width: int
    height: int
    columns: int
    rows: int
    frame_width: int
    frame_height: int
    frame_count: int
    capacity: int
    has_alpha: bool
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AnimationSplitResult:
    report: AnimationSheetReport
    output_dir: Path
    frame_paths: list[Path]

    def summary(self) -> str:
        lines = [
            "动画 Sheet 拆帧完成",
            f"源文件: {self.report.source_path}",
            f"输出目录: {self.output_dir}",
            f"网格: {self.report.columns}x{self.report.rows}",
            f"单帧: {self.report.frame_width}x{self.report.frame_height}",
            f"帧数: {len(self.frame_paths)}",
        ]
        if self.report.warnings:
            lines.append("警告:")
            lines.extend(f"- {item}" for item in self.report.warnings)
        return "\n".join(lines)


@dataclass(frozen=True)
class ComposeSheetOptions:
    frames_dir: str
    output_path: str
    columns: int | None = None
    frame_count: int | None = None
    padding: int = 0
    output_format: str = "png"


@dataclass(frozen=True)
class AnimationComposeResult:
    frames_dir: Path
    output_path: Path
    columns: int
    rows: int
    frame_width: int
    frame_height: int
    frame_count: int
    padding: int
    source_frames: list[Path]

    def summary(self) -> str:
        return "\n".join([
            "动画 Sheet 合成完成",
            f"帧目录: {self.frames_dir}",
            f"输出: {self.output_path}",
            f"网格: {self.columns}x{self.rows}",
            f"单帧: {self.frame_width}x{self.frame_height}",
            f"帧数: {self.frame_count}",
            f"间距: {self.padding}",
        ])


def inspect_animation_sheet(project_root: Path, options: SheetGridOptions) -> AnimationSheetReport:
    source = resolve_source_path(project_root, options.source_path)
    info = inspect_image(source)
    columns, rows, frame_width, frame_height, frame_count, warnings = _derive_grid(
        info.width,
        info.height,
        options,
    )
    return AnimationSheetReport(
        source_path=source,
        width=info.width,
        height=info.height,
        columns=columns,
        rows=rows,
        frame_width=frame_width,
        frame_height=frame_height,
        frame_count=frame_count,
        capacity=columns * rows,
        has_alpha=info.has_alpha,
        warnings=warnings,
    )


def split_animation_sheet(
    project_root: Path,
    options: SheetGridOptions,
    output_dir: str,
    *,
    prefix: str = "",
    overwrite: bool = False,
) -> AnimationSplitResult:
    report = inspect_animation_sheet(project_root, options)
    out_dir = resolve_output_dir(project_root, output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    name_prefix = _safe_prefix(prefix or report.source_path.stem)

    frame_paths: list[Path] = []
    with Image.open(report.source_path) as src:
        image = src.convert("RGBA") if report.has_alpha else src.convert("RGB")
        for index in range(report.frame_count):
            col = index % report.columns
            row = index // report.columns
            left = col * report.frame_width
            top = row * report.frame_height
            box = (left, top, left + report.frame_width, top + report.frame_height)
            frame = image.crop(box)
            frame_path = out_dir / f"{name_prefix}_{index + 1:03d}.png"
            if frame_path.exists() and not overwrite:
                raise FileExistsError(f"帧文件已存在: {frame_path}")
            frame.save(frame_path, format="PNG")
            frame_paths.append(frame_path)

    return AnimationSplitResult(report=report, output_dir=out_dir, frame_paths=frame_paths)


def compose_animation_sheet(
    project_root: Path,
    options: ComposeSheetOptions,
    *,
    overwrite: bool = False,
) -> AnimationComposeResult:
    frames_dir = resolve_output_dir(project_root, options.frames_dir)
    if not frames_dir.is_dir():
        raise FileNotFoundError(f"帧目录不存在: {frames_dir}")
    frame_paths = _frame_files(frames_dir)
    if not frame_paths:
        raise ValueError("帧目录里没有可用图片。")
    frame_count = int(options.frame_count or 0)
    if frame_count > 0:
        if frame_count > len(frame_paths):
            raise ValueError(f"要求合成 {frame_count} 帧，但目录中只有 {len(frame_paths)} 张图。")
        frame_paths = frame_paths[:frame_count]
    frame_count = len(frame_paths)
    columns = int(options.columns or 0) or frame_count
    if columns <= 0:
        raise ValueError("columns 必须大于 0。")
    rows = ceil(frame_count / columns)
    padding = max(0, int(options.padding or 0))

    frames: list[Image.Image] = []
    try:
        for path in frame_paths:
            with Image.open(path) as img:
                frames.append(img.convert("RGBA"))
        frame_width, frame_height = frames[0].size
        for path, frame in zip(frame_paths, frames):
            if frame.size != (frame_width, frame_height):
                raise ValueError(
                    f"帧尺寸不一致: {path.name}={frame.width}x{frame.height}, "
                    f"期望 {frame_width}x{frame_height}"
                )

        width = columns * frame_width + max(0, columns - 1) * padding
        height = rows * frame_height + max(0, rows - 1) * padding
        sheet = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for index, frame in enumerate(frames):
            col = index % columns
            row = index // columns
            sheet.paste(frame, (col * (frame_width + padding), row * (frame_height + padding)))

        output_path = resolve_output_path(project_root, options.output_path, options.output_format or "png")
        if output_path.exists() and not overwrite:
            raise FileExistsError(f"输出文件已存在: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fmt = (output_path.suffix.lstrip(".") or "png").lower()
        if options.output_format and options.output_format.lower() != "auto":
            fmt = options.output_format.lower()
        if fmt in {"jpg", "jpeg"}:
            background = Image.new("RGB", sheet.size, (255, 255, 255))
            background.paste(sheet, mask=sheet.getchannel("A"))
            background.save(output_path, format="JPEG", quality=95, optimize=True)
        else:
            sheet.save(output_path, format="WEBP" if fmt == "webp" else "PNG")
    finally:
        for frame in frames:
            frame.close()

    return AnimationComposeResult(
        frames_dir=frames_dir,
        output_path=output_path,
        columns=columns,
        rows=rows,
        frame_width=frame_width,
        frame_height=frame_height,
        frame_count=frame_count,
        padding=padding,
        source_frames=frame_paths,
    )


def format_animation_sheet_report(report: AnimationSheetReport) -> str:
    lines = [
        "动画 Sheet 检查",
        f"源文件: {report.source_path}",
        f"整图: {report.width}x{report.height}",
        f"网格: {report.columns}x{report.rows}",
        f"单帧: {report.frame_width}x{report.frame_height}",
        f"帧数: {report.frame_count} / 容量 {report.capacity}",
        f"透明: {'是' if report.has_alpha else '否'}",
    ]
    if report.warnings:
        lines.append("警告:")
        lines.extend(f"- {item}" for item in report.warnings)
    return "\n".join(lines)


def resolve_output_dir(project_root: Path, raw_path: str) -> Path:
    raw = (raw_path or "").strip().strip('"')
    if not raw:
        raise ValueError("请填写输出目录。")
    path = Path(raw)
    if not path.is_absolute():
        path = project_root / raw
    path = path.resolve()
    try:
        path.relative_to(project_root.resolve())
    except ValueError as exc:
        raise ValueError("输出目录必须在当前工程目录内。") from exc
    return path


def _derive_grid(
    width: int,
    height: int,
    options: SheetGridOptions,
) -> tuple[int, int, int, int, int, list[str]]:
    frame_count = max(0, int(options.frame_count or 0))
    columns = max(0, int(options.columns or 0))
    rows = max(0, int(options.rows or 0))
    frame_width = max(0, int(options.frame_width or 0))
    frame_height = max(0, int(options.frame_height or 0))
    warnings: list[str] = []

    if frame_width and frame_height:
        if width % frame_width != 0 or height % frame_height != 0:
            raise ValueError("整图尺寸不能被单帧尺寸整除。")
        columns = columns or width // frame_width
        rows = rows or height // frame_height
    elif columns and rows:
        frame_width, frame_height = _frame_size_from_grid(width, height, columns, rows)
    elif frame_count and columns:
        rows = ceil(frame_count / columns)
        frame_width, frame_height = _frame_size_from_grid(width, height, columns, rows)
    elif frame_count and rows:
        columns = ceil(frame_count / rows)
        frame_width, frame_height = _frame_size_from_grid(width, height, columns, rows)
    elif frame_count and width % frame_count == 0:
        columns = frame_count
        rows = 1
        frame_width = width // frame_count
        frame_height = height
    elif frame_count and height % frame_count == 0:
        columns = 1
        rows = frame_count
        frame_width = width
        frame_height = height // frame_count
    else:
        raise ValueError("无法推断 sheet 网格；请填写 columns/rows、单帧宽高，或可整除的帧数。")

    if columns <= 0 or rows <= 0 or frame_width <= 0 or frame_height <= 0:
        raise ValueError("sheet 网格参数无效。")
    capacity = columns * rows
    if frame_count <= 0:
        frame_count = capacity
    if frame_count > capacity:
        raise ValueError(f"帧数 {frame_count} 超过网格容量 {capacity}。")
    if frame_count < capacity:
        warnings.append(f"帧数小于网格容量，尾部 {capacity - frame_count} 格会忽略。")
    return columns, rows, frame_width, frame_height, frame_count, warnings


def _frame_size_from_grid(width: int, height: int, columns: int, rows: int) -> tuple[int, int]:
    if columns <= 0 or rows <= 0:
        raise ValueError("columns/rows 必须大于 0。")
    if width % columns != 0 or height % rows != 0:
        raise ValueError("整图尺寸不能被 columns/rows 整除。")
    return width // columns, height // rows


def _frame_files(frames_dir: Path) -> list[Path]:
    allowed = {".png", ".jpg", ".jpeg", ".webp"}
    return sorted(path for path in frames_dir.iterdir() if path.is_file() and path.suffix.lower() in allowed)


def _safe_prefix(value: str) -> str:
    raw = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value.strip())
    return raw.strip("_") or "frame"
