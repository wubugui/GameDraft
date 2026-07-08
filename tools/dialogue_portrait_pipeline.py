#!/usr/bin/env python3
"""Process generated RPG dialogue portrait sheets.

The expected source is a 3x3 expression sheet on a neutral gray background.
Each grid cell is cropped at fixed coordinates, keyed to transparency, and
resized to a stable 512x512 canvas so expression swaps do not jump.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage


EXPRESSIONS = [
    ("calm", "平静"),
    ("cry", "哭"),
    ("smirk", "嬉笑"),
    ("angry", "愤怒"),
    ("sad", "悲伤"),
    ("laugh", "大笑"),
    ("fear", "惊恐"),
    ("empty_eyes", "眼神空洞"),
    ("zombified", "僵尸化"),
]


def _estimate_bg(rgb: np.ndarray) -> np.ndarray:
    h, w, _ = rgb.shape
    band = max(10, min(h, w) // 24)
    samples = np.concatenate(
        [
            rgb[:band, :, :].reshape(-1, 3),
            rgb[:, :band, :].reshape(-1, 3),
            rgb[:, w - band :, :].reshape(-1, 3),
            rgb[: h // 4, : w // 4, :].reshape(-1, 3),
            rgb[: h // 4, w - w // 4 :, :].reshape(-1, 3),
        ],
        axis=0,
    ).astype(np.float32)
    lum = samples.mean(axis=1)
    neutral = np.max(samples, axis=1) - np.min(samples, axis=1)
    keep = (lum > 120) & (lum < 235) & (neutral < 18)
    if keep.sum() < 64:
        keep = np.ones_like(lum, dtype=bool)
    return np.median(samples[keep], axis=0)


def _flood_bg(near_bg: np.ndarray) -> np.ndarray:
    h, w = near_bg.shape
    bg = np.zeros((h, w), dtype=bool)
    stack: list[tuple[int, int]] = []
    for x in range(w):
        if near_bg[0, x]:
            stack.append((x, 0))
        if near_bg[h - 1, x]:
            stack.append((x, h - 1))
    for y in range(h):
        if near_bg[y, 0]:
            stack.append((0, y))
        if near_bg[y, w - 1]:
            stack.append((w - 1, y))
    while stack:
        x, y = stack.pop()
        if bg[y, x] or not near_bg[y, x]:
            continue
        bg[y, x] = True
        if x > 0:
            stack.append((x - 1, y))
        if x + 1 < w:
            stack.append((x + 1, y))
        if y > 0:
            stack.append((x, y - 1))
        if y + 1 < h:
            stack.append((x, y + 1))
    return bg


def gray_key_to_rgba(cell: Image.Image) -> Image.Image:
    rgb_img = cell.convert("RGB")
    rgb = np.asarray(rgb_img).astype(np.float32)
    bg = _estimate_bg(rgb)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    chroma = np.max(rgb, axis=2) - np.min(rgb, axis=2)
    near_bg = (dist < 32) & (chroma < 34)
    bg_region = _flood_bg(near_bg)

    alpha = np.where(bg_region, 0, 255).astype(np.uint8)
    alpha_img = Image.fromarray(alpha, "L")
    alpha_img = alpha_img.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.45))
    alpha_arr = np.asarray(alpha_img).astype(np.uint8)

    rgba = np.dstack([np.asarray(rgb_img), alpha_arr])
    out = Image.fromarray(rgba, "RGBA")
    return out


def dehalo(rgba: Image.Image) -> Image.Image:
    """Remove the light-gray studio fringe left on the silhouette by the keyer.

    The keyer has no despill, so dark hair against the light-gray backdrop keeps a
    bright rim (a halo) that reads as a white outline on a dark dialogue box. This
    darkens edge-band pixels that are BOTH brighter than their local foreground AND
    grayish (low chroma) — i.e. background contamination — toward the neighbouring
    foreground colour. Alpha is left untouched, so the silhouette never moves, and
    the "brighter than *local* foreground" test makes it a near no-op on characters
    whose edge is legitimately light (grey hair, straw, cloth).
    """
    arr = np.asarray(rgba).astype(np.float32)
    rgb = arr[:, :, :3]
    a = arr[:, :, 3]
    lum = rgb.mean(2)
    chroma = rgb.max(2) - rgb.min(2)
    opaque = a > 40
    interior = ndimage.binary_erosion(opaque, iterations=3)
    k = 9
    num = ndimage.uniform_filter(np.where(interior, lum, 0.0), k)
    den = ndimage.uniform_filter(interior.astype(np.float32), k)
    # no nearby interior (isolated thin strand) -> local_fg=0 so bright specks darken too
    local_fg = np.where(den > 0.05, num / np.maximum(den, 1e-3), 0.0)
    edge = opaque & ~ndimage.binary_erosion(opaque, iterations=2)
    partial = (a > 8) & (a < 235)
    band = edge | partial
    halo = band & (lum > (local_fg + 20.0)) & (chroma < 50.0)
    target = np.minimum(lum, np.maximum(local_fg, 12.0))
    scale = np.where(halo, target / np.maximum(lum, 1e-3), 1.0)[..., None]
    out_rgb = np.clip(rgb * scale, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([out_rgb, a.astype(np.uint8)]), "RGBA")


def _checker(size: tuple[int, int], step: int = 24) -> Image.Image:
    w, h = size
    im = Image.new("RGB", size, (210, 210, 210))
    draw = ImageDraw.Draw(im)
    for y in range(0, h, step):
        for x in range(0, w, step):
            if (x // step + y // step) % 2:
                draw.rectangle((x, y, x + step - 1, y + step - 1), fill=(245, 245, 245))
    return im


def _composite_on(img: Image.Image, bg: Image.Image | tuple[int, int, int]) -> Image.Image:
    base = bg.copy() if isinstance(bg, Image.Image) else Image.new("RGB", img.size, bg)
    base.paste(img.convert("RGBA"), mask=img.getchannel("A"))
    return base


def _font(size: int) -> ImageFont.ImageFont:
    for p in ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def make_qa(slug: str, outputs: list[Path], qa_path: Path) -> None:
    font = _font(15)
    small = _font(12)
    tile = 128
    columns = len(outputs)
    rows = 6
    sheet = Image.new("RGB", (columns * tile, rows * tile), (245, 245, 245))
    draw = ImageDraw.Draw(sheet)
    backgrounds: list[Image.Image | tuple[int, int, int]] = [
        _checker((512, 512)),
        (255, 255, 255),
        (0, 0, 0),
        (255, 0, 0),
        (0, 0, 255),
    ]
    for x_idx, path in enumerate(outputs):
        img = Image.open(path).convert("RGBA")
        draw.text((x_idx * tile + 4, 2), path.stem.replace(f"{slug}_", ""), fill=(20, 20, 20), font=small)
        for y_idx, bg in enumerate(backgrounds):
            comp = _composite_on(img, bg).resize((tile, tile), Image.Resampling.LANCZOS)
            sheet.paste(comp, (x_idx * tile, (y_idx + 1) * tile))
        alpha = Image.merge("RGB", [img.getchannel("A")] * 3).resize((tile, tile), Image.Resampling.LANCZOS)
        sheet.paste(alpha, (x_idx * tile, 0))
    draw.text((4, rows * tile - 20), slug, fill=(20, 20, 20), font=font)
    qa_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(qa_path)


def process_sheet(src: Path, slug: str, out_dir: Path, raw_dir: Path | None = None, inset_px: int | None = None) -> dict:
    sheet = Image.open(src).convert("RGBA")
    w, h = sheet.size
    cols = 3
    rows = 3
    cell_w = w // cols
    cell_h = h // rows
    inset = inset_px if inset_px is not None else max(2, min(w, h) // 512)
    inset = max(0, min(inset, cell_w // 4, cell_h // 4))
    out_dir.mkdir(parents=True, exist_ok=True)
    if raw_dir:
        raw_dir.mkdir(parents=True, exist_ok=True)

    outputs: list[Path] = []
    alpha_bboxes: dict[str, list[int] | None] = {}
    for i, (expr, _label) in enumerate(EXPRESSIONS):
        col = i % cols
        row = i // cols
        box = (
            col * cell_w + inset,
            row * cell_h + inset,
            (col + 1) * cell_w - inset,
            (row + 1) * cell_h - inset,
        )
        raw = sheet.crop(box)
        if raw_dir:
            raw.save(raw_dir / f"{slug}_{expr}_raw.png")
        rgba = gray_key_to_rgba(raw)
        rgba = rgba.resize((512, 512), Image.Resampling.LANCZOS)
        rgba = dehalo(rgba)
        out = out_dir / f"{slug}_{expr}.png"
        rgba.save(out)
        outputs.append(out)
        bbox = rgba.getchannel("A").getbbox()
        alpha_bboxes[expr] = list(bbox) if bbox else None

    qa_path = out_dir / f"{slug}_qa_contact_sheet.png"
    make_qa(slug, outputs, qa_path)
    meta = {
        "slug": slug,
        "source": str(src),
        "grid": {"cols": cols, "rows": rows, "cellWidth": cell_w, "cellHeight": cell_h, "inset": inset},
        "expressions": [{"slug": e, "label": z, "file": f"{slug}_{e}.png"} for e, z in EXPRESSIONS],
        "alphaBboxes": alpha_bboxes,
        "qa": qa_path.name,
    }
    (out_dir / f"{slug}_portrait_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--raw-dir", type=Path)
    ap.add_argument("--inset-px", type=int)
    args = ap.parse_args()
    meta = process_sheet(args.src, args.slug, args.out_dir, args.raw_dir, args.inset_px)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
