"""
视频区间抽帧、色键、底中对齐、规则网格 Atlas 拼接与导出。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image


def bgra_numpy_to_pil_rgba(bgra: np.ndarray) -> Image.Image:
    """OpenCV 帧为 BGRA；PIL/PNG 需 RGBA 字节序，否则红蓝对调偏色。"""
    if bgra.ndim != 3 or bgra.shape[2] != 4:
        raise ValueError("expected HxWx4 BGRA uint8 array")
    rgba = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
    return Image.fromarray(rgba, mode="RGBA")


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
    - max_frames > 0：在 [t0, t1] 上 **只按张数** 均匀取时刻（含两端），与 fps 无关。
    - max_frames == 0：在 [t0, t1] 内按 target_fps 步进取样（不限制张数），供旧版/脚本。
    """
    if t1 < t0:
        return []
    if max_frames > 0:
        n = int(max_frames)
        if n <= 0:
            return []
        if n == 1:
            return [float(t0)]
        return [t0 + (t1 - t0) * (i / (n - 1)) for i in range(n)]
    if fps <= 0:
        return []
    times: List[float] = []
    k = 0
    while True:
        t = t0 + k / fps
        if t > t1 + 1e-6:
            break
        times.append(t)
        k += 1
    return times


def frame_indices_uniform_in_time(
    t0_sec: float,
    t1_sec: float,
    video_fps: float,
    total_frames: int,
    n_out: int,
) -> List[int]:
    """
    在 [t0_sec, t1_sec] 对应的 **连续帧坐标** 上均匀取 n_out 个帧索引。
    不得先把 t0/t1 转成整数帧再 linspace，否则短时间区间会被压成只有 0～1 帧，出现「只有前两帧不同」。
    """
    if n_out < 1:
        return []
    tf = max(1, int(total_frames))
    f_hi = float(tf - 1)
    f0 = float(t0_sec) * float(video_fps)
    f1 = float(t1_sec) * float(video_fps)
    f0 = max(0.0, min(f_hi, f0))
    f1 = max(0.0, min(f_hi, f1))
    if f1 < f0:
        f0, f1 = f1, f0
    if n_out == 1:
        return [int(round(f0))]
    raw = [f0 + (f1 - f0) * (k / (n_out - 1)) for k in range(n_out)]
    idxs = [int(round(x)) for x in raw]
    for k in range(len(idxs)):
        idxs[k] = max(0, min(tf - 1, idxs[k]))
    for k in range(1, len(idxs)):
        if idxs[k] <= idxs[k - 1]:
            idxs[k] = min(tf - 1, idxs[k - 1] + 1)
    return idxs


def _decode_rgba_index_sequence(
    cap: cv2.VideoCapture,
    index_list: List[int],
    meta_times: List[float],
    chroma_enabled: bool,
    chroma_rgb: Tuple[int, int, int],
    chroma_tol: float,
    total_frames: int,
) -> Tuple[List[np.ndarray], List[float]]:
    """
    单路 VideoCapture：首帧 set(POS_FRAMES)+read，之后仅顺序 read前进。
    避免反复 set在同一解码器上失效导致多帧与第二帧相同；每帧 bgr.copy() 再转 RGBA。
    """
    rgba_frames: List[np.ndarray] = []
    frame_times: List[float] = []
    tf = max(1, int(total_frames))
    cur_i: Optional[int] = None
    bgr: Optional[np.ndarray] = None

    for t_meta, want in zip(meta_times, index_list):
        j = max(0, min(tf - 1, int(want)))
        if cur_i is None:
            cap.set(cv2.CAP_PROP_POS_FRAMES, j)
            ret, bgr = cap.read()
            if not ret or bgr is None:
                continue
            cur_i = j
        elif j < cur_i:
            cap.set(cv2.CAP_PROP_POS_FRAMES, j)
            ret, bgr = cap.read()
            if not ret or bgr is None:
                continue
            cur_i = j
        elif j > cur_i:
            while cur_i < j:
                ret, nx = cap.read()
                if not ret or nx is None:
                    bgr = None
                    break
                bgr = nx
                cur_i += 1
            if bgr is None:
                continue

        rgba_frames.append(
            bgr_to_rgba_frame(bgr.copy(), chroma_enabled, chroma_rgb, chroma_tol)
        )
        frame_times.append(float(t_meta))

    return rgba_frames, frame_times


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


def bgra_to_bgr_preview(bgra: np.ndarray, bg_gray: float = 127.5) -> np.ndarray:
    """
    将 BGRA 合成到单色底上再输出 BGR，供界面缩略图/预览使用。
    若直接用 COLOR_BGRA2BGR，会忽略 alpha，透明处仍显示色键前的原色（看起来像没抠掉背景）。
    """
    if bgra.shape[2] != 4:
        return bgra[:, :, :3]
    bgr = bgra[:, :, :3].astype(np.float32)
    a = bgra[:, :, 3:4].astype(np.float32) / 255.0
    bg = np.full_like(bgr, bg_gray)
    out = bgr * a + bg * (1.0 - a)
    return np.clip(out, 0, 255).astype(np.uint8)


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
    """已解码的 BGR 帧转 BGRA（含可选色键），不做 seek。注意：通道顺序为 OpenCV BGRA，非 RGBA。"""
    if chroma_enabled:
        return apply_chroma_key(bgr, chroma_rgb, chroma_tol)
    return bgr_to_bgra_opaque(bgr)


def read_frame_rgba(
    cap: cv2.VideoCapture,
    t_sec: float,
    chroma_enabled: bool,
    chroma_rgb: Tuple[int, int, int],
    chroma_tol: float,
    *,
    frame_index: Optional[int] = None,
    video_fps: float = 0.0,
    total_frames: int = 0,
) -> Optional[np.ndarray]:
    """
    优先按帧号 CAP_PROP_POS_FRAMES 跳转；许多 MP4 仅用 POS_MSEC 会反复落在同一关键帧，导致抽帧全相同。
    """
    if frame_index is not None and total_frames > 0:
        idx = max(0, min(total_frames - 1, int(frame_index)))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    elif total_frames > 0 and video_fps > 1e-6:
        idx = int(round(t_sec * video_fps))
        idx = max(0, min(total_frames - 1, idx))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    else:
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


def pack_frames_native_equal_cells(
    rgba_list: List[np.ndarray],
    pad: int,
    feather_ignore_px: int = 0,
) -> Tuple[List[Image.Image], int, int, List[Tuple[int, int]]]:
    """
    等大单元格、原始像素尺寸（仅 alpha 包围盒裁切，不做整体缩放）。
    cell 宽高 = 各裁切后 max(w,h) + 2*pad；每帧在格内底边 + 水平居中粘贴。
    返回 (cells, cell_w, cell_h, content_sizes)，content_sizes 为每帧 (content_w, content_h)。
    """
    if not rgba_list:
        return [], 0, 0, []
    crops: List[np.ndarray] = []
    for rgba in rgba_list:
        c = _prepare_cropped_rgba(rgba, feather_ignore_px)
        if c is None:
            c = np.zeros((1, 1, 4), dtype=np.uint8)
        crops.append(c)
    content_sizes: List[Tuple[int, int]] = [
        (int(c.shape[1]), int(c.shape[0])) for c in crops
    ]
    max_w = max(int(c.shape[1]) for c in crops)
    max_h = max(int(c.shape[0]) for c in crops)
    cell_w = max_w + 2 * pad
    cell_h = max_h + 2 * pad
    cell_w = max(1, cell_w)
    cell_h = max(1, cell_h)
    cells: List[Image.Image] = []
    for crop in crops:
        cell = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
        h, w = int(crop.shape[0]), int(crop.shape[1])
        pil = bgra_numpy_to_pil_rgba(crop)
        px = (cell_w - w) // 2
        py = cell_h - pad - h
        py = max(pad, py)
        cell.paste(pil, (px, py), pil)
        cells.append(cell)
    return cells, cell_w, cell_h, content_sizes


def build_atlas_native_equal_cells(
    rgba_frames: List[np.ndarray],
    *,
    padding: int,
    feather_ignore_px: int = 0,
    cols: int = 0,
    rows: int = 0,
    frame_index_base: int = 1,
    export_fps: float = 12.0,
    frame_times: Optional[List[float]] = None,
    video_path: str = "",
) -> Tuple[Image.Image, dict[str, Any]]:
    """将 RGBA 帧列表打成 native 等大 cell 图集（与 SpriteEntity 行列序一致）。"""
    if not rgba_frames:
        raise RuntimeError("没有可用于打包的帧")
    n = len(rgba_frames)
    times = frame_times if frame_times is not None and len(frame_times) == n else [float(i) for i in range(n)]
    cells, cell_w, cell_h, content_sizes = pack_frames_native_equal_cells(
        rgba_frames, padding, feather_ignore_px)
    cols, rows = compute_auto_grid(n, cols, rows)
    slots = cols * rows
    if n > slots:
        cols, rows = compute_auto_grid(n, cols, 0)
        slots = cols * rows
    while len(cells) < slots:
        cells.append(Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0)))

    atlas_w = cols * cell_w
    atlas_h = rows * cell_h
    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for i, cell in enumerate(cells[:slots]):
        c = i % cols
        r = i // cols
        atlas.paste(cell, (c * cell_w, r * cell_h))

    base = frame_index_base
    meta: dict[str, Any] = {
        "version": 2,
        "packMode": "native_equal_cells",
        "video": video_path,
        "exportFps": float(export_fps),
        "cols": cols,
        "rows": rows,
        "cellWidth": cell_w,
        "cellHeight": cell_h,
        "padding": padding,
        "frameCount": n,
        "frameIndexBase": base,
        "anchor": "bottom_center",
        "rowMajorOrder": "col=index%cols, row=index//cols（与 GameDraft SpriteEntity 一致）",
        "frames": [
            {
                "logicalIndex": i,
                "atlasIndex": base + i,
                "timeSec": times[i],
                "cellWidth": cell_w,
                "cellHeight": cell_h,
                "contentWidth": content_sizes[i][0],
                "contentHeight": content_sizes[i][1],
            }
            for i in range(n)
        ],
    }
    return atlas, meta


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
        pil = bgra_numpy_to_pil_rgba(crop).resize((nw, nh), Image.Resampling.LANCZOS)
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
    video_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if video_fps < 1e-6:
        video_fps = 30.0

    rgba_frames: List[np.ndarray] = []
    frame_times: List[float] = []

    if total_frames > 0:
        if max_frames > 0:
            idx_list = frame_indices_uniform_in_time(
                t0_sec,
                t1_sec,
                video_fps,
                total_frames,
                int(max_frames),
            )
            n = min(len(idx_list), len(times))
            rgba_frames, frame_times = _decode_rgba_index_sequence(
                cap,
                idx_list[:n],
                times[:n],
                chroma_enabled,
                chroma_rgb,
                chroma_tolerance,
                total_frames,
            )
        else:
            idx_list = [
                max(0, min(total_frames - 1, int(round(float(t) * video_fps))))
                for t in times
            ]
            for k in range(1, len(idx_list)):
                if idx_list[k] <= idx_list[k - 1]:
                    idx_list[k] = min(total_frames - 1, idx_list[k - 1] + 1)
            rgba_frames, frame_times = _decode_rgba_index_sequence(
                cap,
                idx_list,
                times,
                chroma_enabled,
                chroma_rgb,
                chroma_tolerance,
                total_frames,
            )
    else:
        for t in times:
            rgba = read_frame_rgba(
                cap,
                t,
                chroma_enabled,
                chroma_rgb,
                chroma_tolerance,
                video_fps=video_fps,
                total_frames=0,
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


def anim_atlas_frames_from_meta(meta: dict[str, Any]) -> List[Dict[str, int]]:
    """与 anim.json 中 atlasFrames 字段一致：每图集槽位一格，与 states[*].frames 索引对应。"""
    cell_w = int(meta.get("cellWidth", 0))
    cell_h = int(meta.get("cellHeight", 0))
    out: List[Dict[str, int]] = []
    for fi in meta.get("frames", []):
        cw = int(fi.get("cellWidth", cell_w))
        ch = int(fi.get("cellHeight", cell_h))
        ctw = int(fi.get("contentWidth", cw))
        cth = int(fi.get("contentHeight", ch))
        out.append({
            "width": cw,
            "height": ch,
            "contentWidth": ctw,
            "contentHeight": cth,
        })
    return out


def apply_anim_json_world_size(
    d: dict[str, Any],
    *,
    world_w: Optional[float] = None,
    world_h: Optional[float] = None,
) -> None:
    """
    写入 AnimationSetDef 的世界尺寸：world_w / world_h 为 None 或 <=0 时不写该键，
    由运行时按雪碧图单格长宽比推导另一维；两者皆空时默认 worldWidth=100。
    """
    d.pop("worldWidth", None)
    d.pop("worldHeight", None)
    if world_w is not None and world_w > 0:
        d["worldWidth"] = int(round(world_w))
    if world_h is not None and world_h > 0:
        d["worldHeight"] = int(round(world_h))
    if "worldWidth" not in d and "worldHeight" not in d:
        d["worldWidth"] = 100


def export_gamedraft_anim(
    meta: dict[str, Any],
    spritesheet_rel_path: str,
    world_w: Optional[float],
    world_h: Optional[float],
    state_name: str,
    loop: bool,
    *,
    frames: Optional[List[int]] = None,
    frame_rate: Optional[float] = None,
) -> dict[str, Any]:
    """若传入 frames，则使用该列表作为 state 的帧索引（已含 frameIndexBase 的 atlas 序号）。"""
    base = int(meta["frameIndexBase"])
    if frames is None:
        n = int(meta["frameCount"])
        frame_list = [base + i for i in range(n)]
    else:
        frame_list = list(frames)
    fr = int(round(float(frame_rate if frame_rate is not None else meta["exportFps"])))
    out: dict[str, Any] = {
        "spritesheet": spritesheet_rel_path,
        "cols": meta["cols"],
        "rows": meta["rows"],
        "states": {
            state_name: {
                "frames": frame_list,
                "frameRate": fr,
                "loop": loop,
            }
        },
    }
    apply_anim_json_world_size(out, world_w=world_w, world_h=world_h)
    out["cellWidth"] = int(meta["cellWidth"])
    out["cellHeight"] = int(meta["cellHeight"])
    out["atlasFrames"] = anim_atlas_frames_from_meta(meta)
    return out


def export_gamedraft_anim_multi(
    meta: dict[str, Any],
    spritesheet_rel_path: str,
    world_w: Optional[float],
    world_h: Optional[float],
    states: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """
    states: state_name -> { "frames": List[int], "frameRate": int|float, "loop": bool }
    """
    out_states: dict[str, Any] = {}
    for name, spec in states.items():
        out_states[name] = {
            "frames": list(spec["frames"]),
            "frameRate": int(round(float(spec["frameRate"]))),
            "loop": bool(spec["loop"]),
        }
    out: dict[str, Any] = {
        "spritesheet": spritesheet_rel_path,
        "cols": meta["cols"],
        "rows": meta["rows"],
        "states": out_states,
    }
    apply_anim_json_world_size(out, world_w=world_w, world_h=world_h)
    out["cellWidth"] = int(meta["cellWidth"])
    out["cellHeight"] = int(meta["cellHeight"])
    out["atlasFrames"] = anim_atlas_frames_from_meta(meta)
    return out


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


def meta_atlas_to_bgra_frames(
    meta: dict[str, Any],
    atlas_rgba: Image.Image,
) -> Tuple[List[np.ndarray], List[float]]:
    """
    根据导出的 meta.json + 图集 PNG，按行列裁切为与工程内一致的 BGRA 帧列表（顺序与 logicalIndex 一致）。
    """
    required = ("cols", "rows", "cellWidth", "cellHeight", "frameCount")
    for k in required:
        if k not in meta:
            raise ValueError(f"meta 缺少字段: {k}")
    cols = int(meta["cols"])
    rows = int(meta["rows"])
    cw = int(meta["cellWidth"])
    ch = int(meta["cellHeight"])
    n = int(meta["frameCount"])
    if cols <= 0 or rows <= 0 or cw <= 0 or ch <= 0 or n <= 0:
        raise ValueError("meta 中 cols/rows/cellWidth/cellHeight/frameCount 须为正")
    ew, eh = cols * cw, rows * ch
    atlas = atlas_rgba.convert("RGBA")
    if atlas.size != (ew, eh):
        raise ValueError(f"图集像素尺寸 {atlas.size[0]}×{atlas.size[1]} 与 meta 期望 {ew}×{eh} 不一致")
    cells = slice_atlas_cells(atlas, cols, rows, cw, ch, n)
    if len(cells) < n:
        raise ValueError(f"裁切得到 {len(cells)} 格，少于 frameCount={n}")
    frames_meta = meta.get("frames") or []
    times: List[float] = []
    for i in range(n):
        if i < len(frames_meta) and isinstance(frames_meta[i], dict):
            times.append(float(frames_meta[i].get("timeSec", float(i))))
        else:
            times.append(float(i))
    out_bgra: List[np.ndarray] = []
    for pil_cell in cells[:n]:
        arr = np.asarray(pil_cell, dtype=np.uint8)
        if arr.ndim != 3 or arr.shape[2] not in (3, 4):
            raise ValueError("格子图像通道数异常")
        if arr.shape[2] == 3:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2RGBA)
        bgra = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA)
        out_bgra.append(np.ascontiguousarray(bgra))
    return out_bgra, times


def flip_bgra_horizontal(bgra: np.ndarray) -> np.ndarray:
    return cv2.flip(np.ascontiguousarray(bgra), 1)


def scale_bgra_uniform(bgra: np.ndarray, scale: float) -> np.ndarray:
    """scale 在 (0,1] 为缩小；大于 1 为放大（双线性）。"""
    if scale <= 0:
        raise ValueError("scale 须为正")
    if abs(scale - 1.0) < 1e-6:
        return np.ascontiguousarray(bgra)
    h, w = bgra.shape[:2]
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    return cv2.resize(np.ascontiguousarray(bgra), (nw, nh), interpolation=interp)


def save_outputs(
    atlas: Image.Image,
    meta: dict[str, Any],
    out_png: Path,
    out_meta_json: Optional[Path],
    gamedraft: Optional[dict[str, Any]],
    out_anim_json: Optional[Path],
) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out_png, format="PNG")
    if out_meta_json is not None:
        out_meta_json.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if gamedraft is not None and out_anim_json is not None:
        out_anim_json.write_text(json.dumps(gamedraft, ensure_ascii=False, indent=2), encoding="utf-8")
