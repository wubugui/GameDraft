"""Basic image editing operations for the production workbench."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from PIL import Image, ImageEnhance


ImageFormat = Literal["png", "jpeg", "webp"]


@dataclass(frozen=True)
class ImageInfo:
    path: Path
    width: int
    height: int
    mode: str
    detected_format: str
    has_alpha: bool


@dataclass(frozen=True)
class ImageEditOptions:
    source_path: str
    output_path: str
    output_format: str = ""
    resize_width: int | None = None
    resize_height: int | None = None
    keep_aspect: bool = True
    crop_x: int | None = None
    crop_y: int | None = None
    crop_width: int | None = None
    crop_height: int | None = None
    trim_transparent: bool = False
    brightness: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    sharpness: float = 1.0


@dataclass(frozen=True)
class ImageEditResult:
    source_path: Path
    output_path: Path
    output_format: ImageFormat
    original_width: int
    original_height: int
    output_width: int
    output_height: int
    has_alpha: bool
    operations: list[str]

    def summary(self) -> str:
        ops = "；".join(self.operations) if self.operations else "仅保存副本/格式转换"
        return (
            "图片处理完成\n"
            f"源文件: {self.source_path}\n"
            f"输出: {self.output_path}\n"
            f"格式: {self.output_format}\n"
            f"尺寸: {self.original_width}x{self.original_height} -> {self.output_width}x{self.output_height}\n"
            f"透明: {'是' if self.has_alpha else '否'}\n"
            f"操作: {ops}"
        )


def inspect_image(path: Path) -> ImageInfo:
    path = path.resolve()
    with Image.open(path) as img:
        return ImageInfo(
            path=path,
            width=int(img.width),
            height=int(img.height),
            mode=str(img.mode),
            detected_format=(img.format or "").lower(),
            has_alpha=_has_alpha(img),
        )


def resolve_source_path(project_root: Path, raw_path: str) -> Path:
    raw = (raw_path or "").strip().strip('"')
    if not raw:
        raise ValueError("请先选择源图片。")
    path = Path(raw)
    if not path.is_absolute():
        path = project_root / raw
    path = path.resolve()
    if not path.is_file():
        raise FileNotFoundError(f"源图片不存在: {path}")
    return path


def resolve_output_path(project_root: Path, raw_path: str, output_format: str = "") -> Path:
    raw = (raw_path or "").strip().strip('"')
    if not raw:
        raise ValueError("请填写输出路径。")
    path = Path(raw)
    if not path.is_absolute():
        path = project_root / raw
    path = path.resolve()
    try:
        path.relative_to(project_root.resolve())
    except ValueError as exc:
        raise ValueError("输出路径必须在当前工程目录内，避免误覆盖外部文件。") from exc
    fmt = normalize_output_format(output_format, path)
    expected_suffix = ".jpg" if fmt == "jpeg" else f".{fmt}"
    explicit_format = (output_format or "").strip().lower() not in {"", "auto"}
    suffix = path.suffix.lower()
    suffix_matches = suffix in {".jpg", ".jpeg"} if fmt == "jpeg" else suffix == expected_suffix
    if not path.suffix or (explicit_format and not suffix_matches):
        path = path.with_suffix(expected_suffix)
    return path


def apply_image_edit(
    project_root: Path,
    options: ImageEditOptions,
    *,
    overwrite: bool = False,
) -> ImageEditResult:
    source_path = resolve_source_path(project_root, options.source_path)
    output_path = resolve_output_path(project_root, options.output_path, options.output_format)
    output_format = normalize_output_format(options.output_format, output_path)
    if output_path.exists() and not overwrite:
        raise FileExistsError(f"输出文件已存在: {output_path}")

    with Image.open(source_path) as src:
        original_width = int(src.width)
        original_height = int(src.height)
        image = src.copy()

    operations: list[str] = []
    crop_box = _manual_crop_box(image, options)
    if crop_box is not None:
        image = image.crop(crop_box)
        operations.append(
            f"裁剪 x={crop_box[0]}, y={crop_box[1]}, w={crop_box[2] - crop_box[0]}, h={crop_box[3] - crop_box[1]}"
        )

    if options.trim_transparent:
        trimmed = _trim_transparent(image)
        if trimmed is not None:
            image, box = trimmed
            operations.append(
                f"自动裁透明边 x={box[0]}, y={box[1]}, w={box[2] - box[0]}, h={box[3] - box[1]}"
            )
        else:
            operations.append("自动裁透明边：无可裁区域")

    target_size = _target_resize(image, options)
    if target_size is not None and target_size != (image.width, image.height):
        image = image.resize(target_size, Image.Resampling.LANCZOS)
        operations.append(f"缩放到 {target_size[0]}x{target_size[1]}")

    image = _apply_color_adjustments(image, options, operations)
    image = _prepare_for_format(image, output_format)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_kwargs = {}
    if output_format == "jpeg":
        save_kwargs = {"quality": 95, "optimize": True}
    image.save(output_path, format="JPEG" if output_format == "jpeg" else output_format.upper(), **save_kwargs)

    return ImageEditResult(
        source_path=source_path,
        output_path=output_path,
        output_format=output_format,
        original_width=original_width,
        original_height=original_height,
        output_width=int(image.width),
        output_height=int(image.height),
        has_alpha=_has_alpha(image),
        operations=operations,
    )


def normalize_output_format(raw_format: str, output_path: Path) -> ImageFormat:
    fmt = (raw_format or "").strip().lower()
    if not fmt or fmt == "auto":
        suffix = output_path.suffix.lower().lstrip(".")
        fmt = "jpeg" if suffix in {"jpg", "jpeg"} else suffix
    if fmt == "jpg":
        fmt = "jpeg"
    if fmt not in {"png", "jpeg", "webp"}:
        raise ValueError("输出格式只支持 png / jpeg / webp。")
    return fmt  # type: ignore[return-value]


def _manual_crop_box(image: Image.Image, options: ImageEditOptions) -> tuple[int, int, int, int] | None:
    if not options.crop_width or not options.crop_height:
        return None
    x = max(0, int(options.crop_x or 0))
    y = max(0, int(options.crop_y or 0))
    width = max(1, int(options.crop_width))
    height = max(1, int(options.crop_height))
    right = min(image.width, x + width)
    bottom = min(image.height, y + height)
    if right <= x or bottom <= y:
        raise ValueError("裁剪区域不在图片范围内。")
    return x, y, right, bottom


def _trim_transparent(image: Image.Image) -> tuple[Image.Image, tuple[int, int, int, int]] | None:
    if not _has_alpha(image):
        return None
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    box = alpha.getbbox()
    if not box or box == (0, 0, image.width, image.height):
        return None
    return image.crop(box), box


def _target_resize(image: Image.Image, options: ImageEditOptions) -> tuple[int, int] | None:
    width = int(options.resize_width or 0)
    height = int(options.resize_height or 0)
    if width <= 0 and height <= 0:
        return None
    if not options.keep_aspect:
        return max(1, width or image.width), max(1, height or image.height)
    if width > 0 and height > 0:
        ratio = min(width / image.width, height / image.height)
    elif width > 0:
        ratio = width / image.width
    else:
        ratio = height / image.height
    return max(1, round(image.width * ratio)), max(1, round(image.height * ratio))


def _apply_color_adjustments(
    image: Image.Image,
    options: ImageEditOptions,
    operations: list[str],
) -> Image.Image:
    adjustments = [
        ("亮度", options.brightness, ImageEnhance.Brightness),
        ("对比度", options.contrast, ImageEnhance.Contrast),
        ("饱和度", options.saturation, ImageEnhance.Color),
        ("锐化", options.sharpness, ImageEnhance.Sharpness),
    ]
    out = image
    for label, factor, enhancer_cls in adjustments:
        factor = float(factor or 1.0)
        if abs(factor - 1.0) < 0.001:
            continue
        out = _enhance_preserve_alpha(out, enhancer_cls, factor)
        operations.append(f"{label} x{factor:.2f}")
    return out


def _enhance_preserve_alpha(image: Image.Image, enhancer_cls: type, factor: float) -> Image.Image:
    if _has_alpha(image):
        rgba = image.convert("RGBA")
        alpha = rgba.getchannel("A")
        rgb = enhancer_cls(rgba.convert("RGB")).enhance(factor)
        rgb.putalpha(alpha)
        return rgb
    return enhancer_cls(image.convert("RGB")).enhance(factor)


def _prepare_for_format(image: Image.Image, output_format: ImageFormat) -> Image.Image:
    if output_format == "jpeg":
        if _has_alpha(image):
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image.convert("RGBA"), mask=image.convert("RGBA").getchannel("A"))
            return background
        return image.convert("RGB")
    if output_format in {"png", "webp"} and _has_alpha(image):
        return image.convert("RGBA")
    return image.convert("RGB")


def _has_alpha(image: Image.Image) -> bool:
    if image.mode in {"RGBA", "LA"}:
        return True
    return "transparency" in image.info
