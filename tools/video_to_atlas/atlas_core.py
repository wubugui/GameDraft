"""
视频区间抽帧、色键、底中对齐、规则网格 Atlas 拼接与导出。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image


@dataclass
class BuildConfig:
    """t0_sec/t1_sec：闭区间 [t0, t1] 内按 target_fps 均匀采样（见 sample_times）。"""

    t0_sec: float
    t1_sec: float
    target_fps: float
    cell_w: int
    cell_h: int
    cols: int  # 0 = 自动
    rows: int  # 0 = 自动
    padding: int
    chroma_enabled: bool
    chroma_rgb: Tuple[int, int, int]
    chroma_tolerance: float
    max_frames: int  # 0 = 不限制
    frame_index_base: int  # 导出 GameDraft anim JSON 中 frames 列表的起始编号，0 或 1


def sample_times(t0: float, t1: float, fps: float, max_frames: int) -> List[float]:
    """
    在 [t0, t1] 内按 target_fps 均匀取样：t0, t0+1/fps, ...
    包含不超过 t1 的所有样本（右闭：若某帧恰在 t1 仍保留）。

    若设置了 max_frames 且区间内按 FPS 可取的样本数超过该上限，则在 **整段 [t0,t1]**
    上再均匀取 max_frames 个时刻（含两端），避免只截取区间开头导致预览/导出与所选范围不符。
    """
    if t1 < t0 or fps <= 0:
        return []
    times: List[float] = []
    k = 0
    while True:
        t = t0 + k / fps
        if t > t1 + 1e-6:
            break
        times.append(t)
        k += 1
    if not times:
        return []
    if max_frames and len(times) > max_frames:
        m = max_frames
        if m == 1:
            return [float(t0)]
        return [t0 + (t1 - t0) * (i / (m - 1)) for i in range(m)]
    return times


def apply_chroma_key(bgr: np.ndarray, key_rgb: Tuple[int, int, int], tol: float) -> np.ndarray:
    """BGR 输入，输出 BGRA；与 key 距离 <= tol 的像素 alpha=0。"""
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    key = np.array(key_rgb, dtype=np.float32)
    diff = np.linalg.norm(rgb.astype(np.float32) - key.reshape(1, 1, 3), axis=2)
    alpha = np.where(diff <= tol, 0, 255).astype(np.uint8)
    bgra = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    bgra[:, :, 3] = alpha
    return bgra


def bgr_to_bgra_opaque(bgr: np.ndarray) -> np.ndarray:
    bgra = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    bgra[:, :, 3] = 255
    return bgra


def bbox_from_alpha(alpha: np.ndarray, thresh: int = 8) -> Optional[Tuple[int, int, int, int]]:
    ys, xs = np.where(alpha > thresh)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def bgr_to_rgba_frame(
    bgr: np.ndarray,
    chroma_enabled: bool,
    chroma_rgb: Tuple[int, int, int],
    chroma_tol: float,
) -> np.ndarray:
    """已解码的 BGR 帧转 BGRA（含可选色键），不做 seek。"""
    if chroma_enabled:
        return apply_chroma_key(bgr, chroma_rgb, chroma_tol)
    return bgr_to_bgra_opaque(bgr)


def read_frame_rgba(
    cap: cv2.VideoCapture,
    t_sec: float,
    chroma_enabled: bool,
    chroma_rgb: Tuple[int, int, int],
    chroma_tol: float,
) -> Optional[np.ndarray]:
    cap.set(cv2.CAP_PROP_POS_MSEC, float(t_sec * 1000.0))
    ret, bgr = cap.read()
    if not ret or bgr is None:
        return None
    return bgr_to_rgba_frame(bgr, chroma_enabled, chroma_rgb, chroma_tol)


def compute_auto_grid(n: int, cols: int, rows: int) -> Tuple[int, int]:
    if cols > 0 and rows > 0:
        c, r = cols, rows
        if c * r < n:
            r = int(np.ceil(n / c))
        return c, r
    if cols > 0:
        c = cols
        r = int(np.ceil(n / c)) if n else 1
        return c, max(r, 1)
    if rows > 0:
        r = rows
        c = int(np.ceil(n / r)) if n else 1
        return max(c, 1), r
    c = int(np.ceil(np.sqrt(n))) if n else 1
    c = max(c, 1)
    r = int(np.ceil(n / c)) if n else 1
    return c, max(r, 1)


def _uniform_scale_for_frames(
    rgba_crops: List[np.ndarray],
    inner_w: int,
    inner_h: int,
) -> float:
    scales: List[float] = []
    for crop in rgba_crops:
        h, w = crop.shape[:2]
        if w <= 0 or h <= 0:
            continue
        scales.append(min(inner_w / w, inner_h / h))
    if not scales:
        return 1.0
    return float(min(scales))


def _prepare_cropped_rgba(rgba: np.ndarray, padding_ignore: int) -> Optional[np.ndarray]:
    a = rgba[:, :, 3]
    box = bbox_from_alpha(a)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    if padding_ignore > 0:
        x0 = max(0, x0 - padding_ignore)
        y0 = max(0, y0 - padding_ignore)
        x1 = min(rgba.shape[1], x1 + padding_ignore)
        y1 = min(rgba.shape[0], y1 + padding_ignore)
    return rgba[y0:y1, x0:x1].copy()


def pack_frames_bottom_center(
    rgba_list: List[np.ndarray],
    cell_w: int,
    cell_h: int,
    pad: int,
    feather_ignore_px: int = 0,
) -> List[Image.Image]:
    inner_w = max(1, cell_w - 2 * pad)
    inner_h = max(1, cell_h - 2 * pad)
    crops: List[np.ndarray] = []
    for rgba in rgba_list:
        c = _prepare_cropped_rgba(rgba, feather_ignore_px)
        if c is None:
            crops.append(np.zeros((1, 1, 4), dtype=np.uint8))
        else:
            crops.append(c)
    s = _uniform_scale_for_frames(crops, inner_w, inner_h)
    cells: List[Image.Image] = []
    for crop in crops:
        if crop.shape[0] < 1 or crop.shape[1] < 1:
            cells.append(Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0)))
            continue
        nh = max(1, int(round(crop.shape[0] * s)))
        nw = max(1, int(round(crop.shape[1] * s)))
        pil = Image.fromarray(crop, mode="RGBA").resize((nw, nh), Image.Resampling.LANCZOS)
        cell = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
        px = (cell_w - nw) // 2
        py = cell_h - pad - nh
        py = max(pad, py)
        cell.paste(pil, (px, py), pil)
        cells.append(cell)
    return cells


def decode_segment_rgba_frames(
    video_path: str | Path,
    t0_sec: float,
    t1_sec: float,
    target_fps: float,
    max_frames: int,
    chroma_enabled: bool,
    chroma_rgb: Tuple[int, int, int],
    chroma_tolerance: float,
) -> Tuple[List[np.ndarray], List[float]]:
    """按 sample_times 解码 [t0_sec, t1_sec] 内帧，返回 (rgba列表, 各帧时间秒)。"""
    path = str(video_path)
    times = sample_times(t0_sec, t1_sec, target_fps, max_frames)
    if not times:
        return [], []
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {path}")
    rgba_frames: List[np.ndarray] = []
    frame_times: List[float] = []
    for t in times:
        rgba = read_frame_rgba(
            cap,
            t,
            chroma_enabled,
            chroma_rgb,
            chroma_tolerance,
        )
        if rgba is not None:
            rgba_frames.append(rgba)
            frame_times.append(t)
    cap.release()
    return rgba_frames, frame_times


def build_atlas_from_rgba_list(
    rgba_frames: List[np.ndarray],
    frame_times: List[float],
    cfg: BuildConfig,
    video_path: str = "",
    *,
    strip_slice: Optional[Tuple[int, int]] = None,
) -> Tuple[Image.Image, dict[str, Any]]:
    """将已解码的 RGBA 序列打包为 Atlas（不再读视频）。strip_slice 为区段帧条内的 [首索引, 尾索引]（含端点），写入 meta 便于排查。"""
    if len(rgba_frames) != len(frame_times):
        raise ValueError("RGBA 帧数与时间戳数量不一致")
    if not rgba_frames:
        raise RuntimeError("没有可用于打包的帧")
    n = len(rgba_frames)
    times = frame_times
    cols, rows = compute_auto_grid(n, cfg.cols, cfg.rows)
    slots = cols * rows
    if n > slots:
        cols, rows = compute_auto_grid(n, cols, 0)
        slots = cols * rows

    cells = pack_frames_bottom_center(
        rgba_frames,
        cfg.cell_w,
        cfg.cell_h,
        cfg.padding,
    )
    while len(cells) < slots:
        cells.append(Image.new("RGBA", (cfg.cell_w, cfg.cell_h), (0, 0, 0, 0)))

    atlas_w = cols * cfg.cell_w
    atlas_h = rows * cfg.cell_h
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for i, cell in enumerate(cells[:slots]):
        c = i % cols
        r = i // cols
        atlas.paste(cell, (c * cfg.cell_w, r * cfg.cell_h))

    base = cfg.frame_index_base
    meta: dict[str, Any] = {
        "version": 1,
        "video": video_path,
        "t0_sec": cfg.t0_sec,
        "t1_sec": cfg.t1_sec,
        "exportFps": cfg.target_fps,
        "cols": cols,
        "rows": rows,
        "cellWidth": cfg.cell_w,
        "cellHeight": cfg.cell_h,
        "padding": cfg.padding,
        "frameCount": n,
        "frameIndexBase": base,
        "anchor": "bottom_center",
        "rowMajorOrder": "col=index%cols, row=index//cols（与 GameDraft SpriteEntity 一致）",
        "chromaEnabled": cfg.chroma_enabled,
        "frames": [
            {
                "logicalIndex": i,
                "atlasIndex": base + i,
                "timeSec": times[i],
            }
            for i in range(n)
        ],
    }
    if strip_slice is not None:
        meta["stripSliceFrom"] = strip_slice[0]
        meta["stripSliceTo"] = strip_slice[1]
    return atlas, meta


def build_atlas_from_video(
    video_path: str | Path,
    cfg: BuildConfig,
) -> Tuple[Image.Image, dict[str, Any]]:
    path = str(video_path)
    rgba_frames, frame_times = decode_segment_rgba_frames(
        path,
        cfg.t0_sec,
        cfg.t1_sec,
        cfg.target_fps,
        cfg.max_frames,
        cfg.chroma_enabled,
        cfg.chroma_rgb,
        cfg.chroma_tolerance,
    )
    if not rgba_frames:
        raise RuntimeError("区间内无采样帧：请检查时间与 FPS")
    return build_atlas_from_rgba_list(rgba_frames, frame_times, cfg, path)


def first_last_frame_diff_score(rgba_frames: List[np.ndarray]) -> Optional[float]:
    """粗略首尾差异（用于还原循环是否跳变）；越小越接近。RGBA 缩小后 MSE。"""
    if len(rgba_frames) < 2:
        return None
    a = rgba_frames[0]
    b = rgba_frames[-1]
    def small(x: np.ndarray) -> np.ndarray:
        return cv2.resize(x, (64, 64), interpolation=cv2.INTER_AREA)
    sa, sb = small(a), small(b)
    if sa.shape != sb.shape:
        return None
    diff = np.mean((sa.astype(np.float32) - sb.astype(np.float32)) ** 2)
    return float(diff)


def export_gamedraft_anim(
    meta: dict[str, Any],
    spritesheet_rel_path: str,
    world_w: float,
    world_h: float,
    state_name: str,
    loop: bool,
) -> dict[str, Any]:
    n = int(meta["frameCount"])
    base = int(meta["frameIndexBase"])
    frames = [base + i for i in range(n)]
    return {
        "spritesheet": spritesheet_rel_path,
        "cols": meta["cols"],
        "rows": meta["rows"],
        "worldWidth": int(round(world_w)),
        "worldHeight": int(round(world_h)),
        "states": {
            state_name: {
                "frames": frames,
                "frameRate": int(round(float(meta["exportFps"]))),
                "loop": loop,
            }
        },
    }


def slice_atlas_cells(
    atlas: Image.Image,
    cols: int,
    rows: int,
    cell_w: int,
    cell_h: int,
    n_cells: int,
) -> List[Image.Image]:
    """按线性索引 0..n_cells-1 裁切格子（与运行时一致）。"""
    out: List[Image.Image] = []
    for i in range(n_cells):
        c = i % cols
        r = i // cols
        if r >= rows:
            break
        box = (c * cell_w, r * cell_h, (c + 1) * cell_w, (r + 1) * cell_h)
        out.append(atlas.crop(box))
    return out


def save_outputs(
    atlas: Image.Image,
    meta: dict[str, Any],
    out_png: Path,
    out_meta_json: Path,
    gamedraft: Optional[dict[str, Any]],
    out_anim_json: Optional[Path],
) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out_png, format="PNG")
    out_meta_json.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if gamedraft is not None and out_anim_json is not None:
        out_anim_json.write_text(json.dumps(gamedraft, ensure_ascii=False, indent=2), encoding="utf-8")
