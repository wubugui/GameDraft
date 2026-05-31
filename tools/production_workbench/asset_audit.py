"""Asset inventory and dimension audit for production planning."""
from __future__ import annotations

import re
import struct
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
AUDIO_EXTS = {".ogg", ".mp3", ".wav", ".m4a", ".flac"}


@dataclass
class AssetRecord:
    rel_path: str
    category: str
    ext: str
    size_bytes: int
    detected_format: str = ""
    width: int | None = None
    height: int | None = None
    has_alpha: bool | None = None
    is_animation_sheet: bool = False
    note: str = ""


@dataclass
class AssetAuditReport:
    project_root: Path
    assets_root: Path
    images: list[AssetRecord]
    audio: list[AssetRecord]
    other: list[AssetRecord]

    @property
    def total_size_bytes(self) -> int:
        return sum(x.size_bytes for x in [*self.images, *self.audio, *self.other])


def audit_asset_specs(project_root: Path) -> AssetAuditReport:
    project_root = project_root.resolve()
    assets_root = project_root / "public" / "resources" / "runtime"
    if not assets_root.is_dir():
        assets_root = project_root / "public"

    images: list[AssetRecord] = []
    audio: list[AssetRecord] = []
    other: list[AssetRecord] = []
    for path in sorted(assets_root.rglob("*")):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        rel = path.relative_to(project_root).as_posix()
        size = path.stat().st_size
        category = _classify_asset(project_root, path)
        if ext in IMAGE_EXTS:
            width, height, alpha, note, detected_format = _read_image_info(path)
            images.append(
                AssetRecord(
                    rel_path=rel,
                    category=category,
                    ext=ext.lstrip("."),
                    detected_format=detected_format or ext.lstrip("."),
                    size_bytes=size,
                    width=width,
                    height=height,
                    has_alpha=alpha,
                    is_animation_sheet=_is_animation_sheet(path),
                    note=note,
                )
            )
        elif ext in AUDIO_EXTS:
            audio.append(
                AssetRecord(
                    rel_path=rel,
                    category="audio",
                    ext=ext.lstrip("."),
                    size_bytes=size,
                )
            )
        elif ext:
            other.append(
                AssetRecord(
                    rel_path=rel,
                    category=category,
                    ext=ext.lstrip("."),
                    size_bytes=size,
                )
            )

    return AssetAuditReport(
        project_root=project_root,
        assets_root=assets_root,
        images=images,
        audio=audio,
        other=other,
    )


def classify_asset_path(project_root: Path, path: Path) -> str:
    """Return the same coarse asset category used by the deep audit."""

    return _classify_asset(project_root, path)


def format_asset_audit_report(report: AssetAuditReport) -> str:
    category_counts = Counter(x.category for x in report.images)
    ext_counts = Counter(x.detected_format or x.ext for x in report.images)
    dimension_counts = Counter(
        f"{x.width}x{x.height}"
        for x in report.images
        if x.width is not None and x.height is not None
    )
    unknown_dims = [x for x in report.images if x.width is None or x.height is None]
    format_mismatches = [
        x for x in report.images
        if x.detected_format and x.ext and x.detected_format != x.ext
    ]
    alpha_count = sum(1 for x in report.images if x.has_alpha)
    animation_sheets = [x for x in report.images if x.is_animation_sheet]
    large_images = sorted(
        report.images,
        key=lambda x: x.size_bytes,
        reverse=True,
    )[:12]

    lines = [
        "素材规格审计",
        f"工程: {report.project_root}",
        f"扫描根: {report.assets_root}",
        (
            f"图片 {len(report.images)} | 音频 {len(report.audio)} | "
            f"其它 {len(report.other)} | 总体积 {_fmt_bytes(report.total_size_bytes)}"
        ),
        "",
        "目录组织:",
    ]
    if category_counts:
        for category, count in category_counts.most_common():
            lines.append(f"- {category}: {count}")
    else:
        lines.append("- 无图片素材")

    lines.extend(["", "图片格式:"])
    if ext_counts:
        for ext, count in ext_counts.most_common():
            lines.append(f"- {ext}: {count}")
    else:
        lines.append("- 无")

    lines.extend(["", "常见尺寸:"])
    if dimension_counts:
        for dim, count in dimension_counts.most_common(12):
            lines.append(f"- {dim}: {count}")
    else:
        lines.append("- 暂无可读取尺寸")

    lines.extend([
        "",
        f"透明通道: {alpha_count} 张图片可确认有 alpha",
        f"动画 sheet: {len(animation_sheets)} 张",
    ])
    if animation_sheets:
        for item in animation_sheets[:12]:
            lines.append(
                f"- {item.rel_path}  {item.width or '?'}x{item.height or '?'}  {_fmt_bytes(item.size_bytes)}"
            )

    if unknown_dims:
        lines.extend(["", f"无法读取尺寸: {len(unknown_dims)}"])
        for item in unknown_dims[:12]:
            reason = f" ({item.note})" if item.note else ""
            lines.append(f"- {item.rel_path}{reason}")

    if format_mismatches:
        lines.extend(["", f"扩展名/实际格式不一致: {len(format_mismatches)}"])
        for item in format_mismatches[:12]:
            lines.append(f"- {item.rel_path}: .{item.ext} 文件头={item.detected_format}")

    lines.extend(["", "最大图片:"])
    if large_images:
        for item in large_images:
            alpha = "alpha" if item.has_alpha else "opaque/unknown"
            lines.append(
                f"- {item.rel_path}  {item.width or '?'}x{item.height or '?'}  "
                f"{_fmt_bytes(item.size_bytes)}  {alpha}"
            )
    else:
        lines.append("- 无")

    lines.extend(["", "给 GPT 素材工作台的含义:"])
    lines.append("- 后续重抽应优先按上述目录分类、常见尺寸和 alpha 需求生成。")
    lines.append("- animation/atlas.png 类素材应走帧动画 sheet 流程，不应按普通静态图处理。")
    lines.append("- scenes/backgrounds/props/npcs/minigames 应使用不同 prompt 模板和验收规则。")
    return "\n".join(lines)


def _classify_asset(project_root: Path, path: Path) -> str:
    rel = path.relative_to(project_root).as_posix().lower()
    if "/audio/" in rel:
        return "audio"
    if "/animation/" in rel:
        return "animation"
    if "/scenes/" in rel:
        return "scene"
    if "/images/backgrounds/" in rel:
        return "background"
    if "/images/characters/" in rel or "/images/npcs/" in rel:
        return "character"
    if "/images/props/" in rel or "/illustrations/道具/" in rel:
        return "prop"
    if "/images/minigames/" in rel:
        return "minigame"
    if "/images/illustrations/" in rel:
        return "illustration"
    return "other"


def _is_animation_sheet(path: Path) -> bool:
    if path.name.lower() in {"atlas.png", "sheet.png", "spritesheet.png"}:
        return True
    parent = path.parent
    return (parent / "anim.json").is_file() or (parent / "atlas.meta.json").is_file()


def _read_image_info(path: Path) -> tuple[int | None, int | None, bool | None, str, str]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        return None, None, None, str(exc), ""
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            w, h, a, note = _read_png_info(data)
            return w, h, a, note, "png"
        if data.startswith(b"\xff\xd8"):
            w, h, a, note = _read_jpeg_info(data)
            return w, h, a, note, "jpeg"
        if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            w, h, a, note = _read_webp_info(data)
            return w, h, a, note, "webp"
        if data.startswith((b"GIF87a", b"GIF89a")):
            w, h, a, note = _read_gif_info(data)
            return w, h, a, note, "gif"
        if path.suffix.lower() == ".svg" or data.lstrip().startswith(b"<svg"):
            w, h, a, note = _read_svg_info(data)
            return w, h, a, note, "svg"
    except (struct.error, ValueError, UnicodeDecodeError) as exc:
        return None, None, None, str(exc), ""
    return None, None, None, "unsupported image format", ""


def _read_png_info(data: bytes) -> tuple[int | None, int | None, bool | None, str]:
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 33:
        return None, None, None, "invalid png"
    width, height = struct.unpack(">II", data[16:24])
    color_type = data[25]
    alpha = color_type in {4, 6} or b"tRNS" in data
    return width, height, alpha, ""


def _read_jpeg_info(data: bytes) -> tuple[int | None, int | None, bool | None, str]:
    if not data.startswith(b"\xff\xd8"):
        return None, None, None, "invalid jpeg"
    i = 2
    while i < len(data) - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        i += 2
        if marker in {0xD8, 0xD9}:
            continue
        if i + 2 > len(data):
            break
        length = struct.unpack(">H", data[i:i + 2])[0]
        if length < 2 or i + length > len(data):
            break
        if marker in {
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        }:
            if length < 7:
                break
            height, width = struct.unpack(">HH", data[i + 3:i + 7])
            return width, height, False, ""
        i += length
    return None, None, None, "jpeg size marker not found"


def _read_gif_info(data: bytes) -> tuple[int | None, int | None, bool | None, str]:
    if not (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")) or len(data) < 10:
        return None, None, None, "invalid gif"
    width, height = struct.unpack("<HH", data[6:10])
    return width, height, None, ""


def _read_webp_info(data: bytes) -> tuple[int | None, int | None, bool | None, str]:
    if len(data) < 30 or not data.startswith(b"RIFF") or data[8:12] != b"WEBP":
        return None, None, None, "invalid webp"
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        flags = data[20]
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height, bool(flags & 0b00010000), ""
    if chunk == b"VP8L" and len(data) >= 25:
        b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
        width = 1 + (((b1 & 0x3F) << 8) | b0)
        height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return width, height, True, ""
    if chunk == b"VP8 " and len(data) >= 30:
        # Lossy VP8 stores dimensions after the frame tag and start code.
        start = data.find(b"\x9d\x01\x2a", 20)
        if start >= 0 and start + 7 <= len(data):
            width, height = struct.unpack("<HH", data[start + 3:start + 7])
            return width & 0x3FFF, height & 0x3FFF, False, ""
    return None, None, None, "unsupported webp chunk"


def _read_svg_info(data: bytes) -> tuple[int | None, int | None, bool | None, str]:
    text = data[:4096].decode("utf-8", errors="ignore")
    width = _svg_number(text, "width")
    height = _svg_number(text, "height")
    if width is not None and height is not None:
        return int(width), int(height), True, ""
    viewbox = re.search(r"viewBox\s*=\s*['\"]([^'\"]+)['\"]", text, re.IGNORECASE)
    if viewbox:
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", viewbox.group(1))]
        if len(nums) >= 4:
            return int(nums[2]), int(nums[3]), True, ""
    return None, None, True, "svg width/height not found"


def _svg_number(text: str, attr: str) -> float | None:
    match = re.search(rf"\b{attr}\s*=\s*['\"]\s*([0-9]+(?:\.[0-9]+)?)", text, re.IGNORECASE)
    return float(match.group(1)) if match else None


def _fmt_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"
