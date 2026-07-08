"""从「完整插画」中抠出人物/主体为干净透明前景层（用于过场视差分层）。

与 matting.py 的差异：matting.py 的 fusion 面向「灰底/纯底」的角色视频帧；本模块面向
**嵌在复杂背景里的插画人物**（无可键纯底），在 BiRefNet 基础上做定向清理，硬性保证：
  - 无 halo / 白边（压掉「半透且明显比人物亮」的边缘/缝隙背景渗入）
  - 不多扣背景（透过缝隙露出的背景被清零，如剑与颈之间的天空）
  - 不扣坏内部（只补「被实心包围的暗洞」，亮部/金符纸等高 alpha 实心区不动）
  - 去远处杂散（只保留够大的连通域；多人物帧保留所有大块）

用法：
    from tools.animation_pipeline.matte_illustration import clean_matte
    rgba = clean_matte(rgb_uint8_HxWx3)   # 返回 RGBA uint8

铁律（与用户约定）：每次抠完必须目检——白底看 halo/白边、看内部是否被扣坏；
本函数抠不干净时改用 LibTV：让 AI 把人物之外整体换纯洋红底再本地色键（见 cutscene-orchestration-notes）。
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

from . import matting


def clean_matte(
    rgb: np.ndarray,
    *,
    bright_bleed_delta: float = 42.0,
    speck_frac: float = 0.02,
    edge_shrink: float = 0.06,
) -> np.ndarray:
    """rgb uint8 HxWx3 -> rgba uint8 HxWx4。BiRefNet + 背景渗入清零 + 去杂散 + 轻收边。"""
    a = matting.matte(rgb, "fusion").astype(np.float32)
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    fig_lum = float(np.median(lum[a > 0.85])) if (a > 0.85).any() else 40.0

    # 1) 去远处杂散：只保留够大的连通域（多人物帧保留所有大块）
    solid = a > 0.5
    lbl, n = ndimage.label(solid)
    if n > 0:
        sz = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
        mx = sz.max()
        keep = np.isin(lbl, [i + 1 for i, s in enumerate(sz) if s > mx * speck_frac])
        a = np.where(ndimage.binary_dilation(keep, iterations=3), a, 0.0)

    # 2) 背景渗入清零：半透(0.02<a<0.85) 且明显比人物亮 → 边缘/缝隙里的背景，清零
    partial = (a > 0.02) & (a < 0.85)
    a[partial & (lum > fig_lum + bright_bleed_delta)] = 0.0

    # 3) 补内部真洞：被实心包围、且非「亮背景」的暗洞
    filled = ndimage.binary_fill_holes(a > 0.5)
    dark_hole = filled & (a < 0.5) & (lum < fig_lum + bright_bleed_delta)
    a = np.maximum(a, dark_hole.astype(np.float32))

    # 4) 轻收最外软边（去暗 halo 环，不硬化整体、保留细节）
    er = ndimage.grey_erosion(a, size=(2, 2))
    a = np.where(a < 0.85, np.minimum(a, er + edge_shrink), a)

    return np.dstack([rgb, (np.clip(a, 0.0, 1.0) * 255).astype(np.uint8)])


def halo_stats(rgba: np.ndarray) -> dict:
    """给抠像做体检：半透边缘占比、边缘亮度、可疑内部半透点数（供自动初筛）。"""
    a = rgba[..., 3].astype(np.float32) / 255.0
    rgb = rgba[..., :3].astype(np.float32)
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    edge = (a > 0.03) & (a < 0.9)
    solid = a > 0.5
    interior_semi = int((~solid & (a > 0.05) & (a < 0.35)).sum())
    return {
        "edge_frac_pct": round(float(edge.mean()) * 100, 3),
        "edge_lum": round(float(lum[edge].mean()) if edge.any() else 0.0, 1),
        "interior_semi_pts": interior_semi,
        "coverage_pct": round(float(solid.mean()) * 100, 1),
    }
