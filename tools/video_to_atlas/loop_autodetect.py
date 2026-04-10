"""
顺序解码 + 指纹时间线，用于自动寻找首尾 MSE 最小的循环区间。
"""
from __future__ import annotations

import bisect
import math
from typing import Callable, List, Optional, Tuple

import cv2
import numpy as np

from atlas_core import bbox_from_alpha, bgr_to_rgba_frame

FP_SIZE = 64

# 与 first_last_frame_diff_score 同量级；高于此仍提示可能可见跳变
MSE_WARN_THRESHOLD = 500.0


def _rgba_fingerprint_flat(rgba: np.ndarray) -> np.ndarray:
    """整帧缩放到 FP_SIZE²，BGR float32（与旧版整图 MSE 接近）。"""
    bgr = cv2.cvtColor(rgba, cv2.COLOR_BGRA2BGR)
    return cv2.resize(bgr, (FP_SIZE, FP_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32)


def _rgba_pose_fingerprint(rgba: np.ndarray) -> np.ndarray:
    """
    以非透明区域包围盒裁出角色，等比缩放后置于固定方格中心。
    首尾对比更侧重「姿势/轮廓」而非背景；无有效 alpha 时退回整帧。
    """
    alpha = rgba[:, :, 3]
    box = bbox_from_alpha(alpha, thresh=12)
    if box is None:
        return _rgba_fingerprint_flat(rgba)
    x0, y0, x1, y1 = box
    if (x1 - x0) * (y1 - y0) < 24:
        return _rgba_fingerprint_flat(rgba)
    pad = max(2, int(0.02 * max(x1 - x0, y1 - y0)))
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(rgba.shape[1], x1 + pad)
    y1 = min(rgba.shape[0], y1 + pad)
    crop = rgba[y0:y1, x0:x1]
    bgr = cv2.cvtColor(crop, cv2.COLOR_BGRA2BGR)
    ch, cw = bgr.shape[:2]
    if ch < 2 or cw < 2:
        return _rgba_fingerprint_flat(rgba)
    sm = max(ch, cw)
    scale = (FP_SIZE - 2) / float(sm)
    nh, nw = max(1, int(round(ch * scale))), max(1, int(round(cw * scale)))
    small = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.full((FP_SIZE, FP_SIZE, 3), 114, dtype=np.uint8)
    oy = (FP_SIZE - nh) // 2
    ox = (FP_SIZE - nw) // 2
    canvas[oy : oy + nh, ox : ox + nw] = small
    return canvas.astype(np.float32)


def _mse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean((a - b) ** 2))


def default_step_sec(fps: float) -> float:
    return min(1.0 / max(fps, 1.0), 0.05)


def build_fingerprint_timeline(
    video_path: str,
    step_sec: float,
    chroma_enabled: bool,
    chroma_rgb: Tuple[int, int, int],
    chroma_tol: float,
    progress: Optional[Callable[[int, int], None]] = None,
    pose_focus: bool = True,
) -> Tuple[List[float], List[np.ndarray], float, float]:
    """
    顺序 read，按时间步长采样指纹。
    step_sec <= 0 时按 default_step_sec(fps) 自动取步长。
    pose_focus=True（默认）：按 alpha 包围盒裁角色再归一化，便于找「首尾姿势接近」的区间以便无缝帧动画。
    pose_focus=False：整帧缩小，与早期行为接近。
    返回 (times, fingerprints, duration_sec, fps)。
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    if step_sec <= 0:
        step_sec = default_step_sec(fps)
    fc = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_guess = fc / fps if fps > 0 else 0.0

    times: List[float] = []
    fingerprints: List[np.ndarray] = []

    next_sample_t = 0.0
    idx = 0
    max_est = int(fc) + 10 if fc > 0 else 100000
    last_t_sec = 0.0
    last_bgr: np.ndarray | None = None

    while True:
        ret, bgr = cap.read()
        if not ret or bgr is None:
            break
        msec = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
        if msec > 0:
            t_sec = msec / 1000.0
        else:
            t_sec = idx / max(fps, 1e-6)
        last_t_sec = t_sec
        last_bgr = bgr
        idx += 1

        if t_sec + 1e-6 >= next_sample_t:
            rgba = bgr_to_rgba_frame(bgr, chroma_enabled, chroma_rgb, chroma_tol)
            times.append(t_sec)
            if pose_focus:
                fingerprints.append(_rgba_pose_fingerprint(rgba))
            else:
                fingerprints.append(_rgba_fingerprint_flat(rgba))
            next_sample_t += step_sec
            while next_sample_t <= t_sec + 1e-9:
                next_sample_t += step_sec

        if progress and idx % 30 == 0:
            est = int(fc) if fc > 0 else idx
            progress(min(idx, est), max(int(fc), 1))

    cap.release()

    # 顺序读的最后几帧若落在两次 step 之间，原时间线可能停在「倒数第二次采样」，
    # 使得 t_cut 常大于 times[-1]，bisect 尾索引恒为 n-1（像总在用全局最后一帧当尾帧）。
    if last_bgr is not None and times and last_t_sec > times[-1] + 1e-4:
        rgba = bgr_to_rgba_frame(last_bgr, chroma_enabled, chroma_rgb, chroma_tol)
        times.append(last_t_sec)
        if pose_focus:
            fingerprints.append(_rgba_pose_fingerprint(rgba))
        else:
            fingerprints.append(_rgba_fingerprint_flat(rgba))

    duration = duration_guess
    if times:
        duration = max(duration, times[-1] + 1.0 / max(fps, 1.0))

    if progress:
        progress(max(int(fc), 1), max(int(fc), 1))

    if len(times) < 2:
        raise RuntimeError("采样点过少，无法搜索循环（请缩短 step 或检查视频）")

    return times, fingerprints, float(duration), fps


def _last_index_before(times: List[float], t_cut: float) -> int:
    """最大 j 满足 times[j] <= t_cut；若无则 -1。"""
    pos = bisect.bisect_right(times, t_cut) - 1
    return pos


def loop_mse_for_start(
    times: List[float],
    fingerprints: List[np.ndarray],
    duration: float,
    fps: float,
    i_start: int,
    L_sec: float,
) -> Optional[Tuple[float, float, float]]:
    """
    固定起点索引与区间长度 L，返回 (t0, t1, mse)；不合法返回 None。

    匹配方式：在离散时间线 times上，t0=times[i_start]，t1=t0+L。
    尾帧索引 j为「满足 times[j] <= t1-eps 的最大 j」，且要求 j>i_start；
    MSE = 指纹[i_start] 与 指纹[j] 的均方误差（64x64 BGR，姿势优先时为 alpha 包围盒内归一化图）。
    eps 约半帧，避免把恰在 t1 上的采样当尾帧。

    若时间线在视频末尾缺采样，历史上常出现「任意 t1 都使 j 落在全局最后一个索引」，
    表现为总拿整段最后一格当尾帧；build_fingerprint_timeline 已补顺序读的最后一帧缓解此问题。
    """
    eps = max(1e-4, 1.0 / (2.0 * max(fps, 1.0)))
    t0 = times[i_start]
    t1 = t0 + L_sec
    if t1 > duration + 0.05:
        return None
    t_cut = t1 - eps
    j_end = _last_index_before(times, t_cut)
    if j_end < 0 or j_end <= i_start:
        return None
    mse_v = _mse(fingerprints[i_start], fingerprints[j_end])
    return (t0, t1, mse_v)


def best_loop_fixed_length(
    times: List[float],
    fingerprints: List[np.ndarray],
    duration: float,
    fps: float,
    L_sec: float,
    progress: Optional[Callable[[int, int], None]] = None,
) -> Tuple[float, float, float]:
    """保持长度 L，平移起点，使首尾「姿势指纹」MSE 最小。返回 (best_t0, best_t1, mse)。"""
    if L_sec <= 1e-6:
        raise ValueError("区间长度必须大于 0")

    best_mse = math.inf
    best_t0, best_t1 = 0.0, min(L_sec, duration)

    n = len(times)
    for i in range(n):
        r = loop_mse_for_start(times, fingerprints, duration, fps, i, L_sec)
        if r is None:
            continue
        t0, t1, mse_v = r
        if mse_v < best_mse:
            best_mse = mse_v
            best_t0, best_t1 = t0, t1
        if progress and i % 20 == 0:
            progress(i, n)

    if progress:
        progress(n, n)

    if best_mse is math.inf:
        raise RuntimeError("当前长度下没有合法区间，请缩短 L 或缩小步长")

    return best_t0, best_t1, float(best_mse)


def best_loop_search_length(
    times: List[float],
    fingerprints: List[np.ndarray],
    duration: float,
    fps: float,
    L_min: float,
    L_max: float,
    L_step: float,
    progress: Optional[Callable[[int, int], None]] = None,
) -> Tuple[float, float, float]:
    """在 [L_min, L_max] 内按 L_step 枚举 L，对每个 L 做 best_loop_fixed_length，取全局最小 MSE。"""
    if L_min <= 0 or L_max < L_min or L_step <= 0:
        raise ValueError("无效的 L_min/L_max/L_step")

    best_mse = math.inf
    best_t0, best_t1 = 0.0, duration

    L = L_min
    step_count = 0
    L_values: List[float] = []
    while L <= L_max + 1e-9:
        L_values.append(L)
        L += L_step

    total = len(L_values)
    for k, L_sec in enumerate(L_values):
        try:
            t0, t1, mse_v = best_loop_fixed_length(
                times, fingerprints, duration, fps, L_sec, progress=None
            )
        except RuntimeError:
            continue
        if mse_v < best_mse:
            best_mse = mse_v
            best_t0, best_t1 = t0, t1
        if progress:
            progress(k + 1, total)

    if best_mse is math.inf:
        raise RuntimeError("在给定长度范围内未找到合法区间")

    return best_t0, best_t1, float(best_mse)
