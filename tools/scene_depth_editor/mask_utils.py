from __future__ import annotations

from dataclasses import dataclass

from PIL import Image, ImageFilter, ImageOps


@dataclass(slots=True)
class AutoMaskSettings:
    threshold: int = 170
    near_is_bright: bool = True
    grow_passes: int = 1
    shrink_passes: int = 0
    blur_radius: float = 1.0


def build_foreground_mask(depth_image: Image.Image, settings: AutoMaskSettings) -> Image.Image:
    source = depth_image.convert("L")
    if not settings.near_is_bright:
        source = ImageOps.invert(source)

    mask = source.point(lambda value: 255 if value >= settings.threshold else 0, mode="L")

    for _ in range(max(0, settings.grow_passes)):
        mask = mask.filter(ImageFilter.MaxFilter(3))

    for _ in range(max(0, settings.shrink_passes)):
        mask = mask.filter(ImageFilter.MinFilter(3))

    if settings.blur_radius > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=settings.blur_radius))
        mask = mask.point(lambda value: 255 if value >= 128 else 0, mode="L")

    return mask


def apply_mask_to_image(image: Image.Image, mask: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    alpha = mask.convert("L")
    rgba.putalpha(alpha)
    return rgba

