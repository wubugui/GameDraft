"""运行时着色式 `sc3Shade` 的 CPU 镜像 —— **预览用**（不含灯体）。

    out = base · E_目标
    E_目标 = gi·E_烘焙 + E_天光 + E_环境 + E_太阳

    E_天光   = SkySH( normalize(mix(Bdir, N, w)) ) · V ,   w = 1 − (1−V)²
    E_环境   = 环境色 · 强度 · clamp(0.28 + 0.72·AO, 0, 1.2)
    E_太阳   = 日色 · 强度 · (N·ω_s)₊ · clamp(a + b·ω_s, 0, 1)

逐字对应 `src/rendering/lighting/shadeCore3.glsl` 的 sc3Shade 与方案 §6.1。
程序性天空与烘焙没有耦合：`sky_sh` 是运行时由 `sky_irradiance_sh` 算的，这里只是
把它和烘焙出来的遮蔽/基底合成，让你在烘焙工具里就能预览「重打光 + 换时刻」的成品。
"""
from __future__ import annotations

import numpy as np

from .sky import sh_basis


def sky_irradiance_at(sky_sh: np.ndarray, dirs: np.ndarray) -> np.ndarray:
    """`SkySH(ω) = max(Σ coeff·basis(ω), 0)`。sky_sh: (9,3)，dirs: (...,3) → (...,3)。"""
    flat = np.asarray(dirs, np.float32).reshape(-1, 3)
    b = sh_basis(flat[:, 0], flat[:, 1], flat[:, 2])
    e = np.maximum(b @ sky_sh, 0.0)
    return e.reshape(dirs.shape[:-1] + (3,)).astype(np.float32)


def shade(base: np.ndarray, e_baked: np.ndarray, normal: np.ndarray,
          bent: np.ndarray, vis: np.ndarray, ao: np.ndarray, vfit: np.ndarray,
          sky_sh: np.ndarray, gi: float = 1.0,
          sun_dir: np.ndarray | None = None,
          sun_color=(1.0, 1.0, 1.0), sun_intensity: float = 0.0,
          ambient_color=(1.0, 1.0, 1.0), ambient_intensity: float = 0.0) -> np.ndarray:
    """CPU 侧着色，返回线性 HDR (h,w,3)。所有输入分辨率一致。"""
    h, w = base.shape[:2]
    N = normal.reshape(-1, 3).astype(np.float32)
    vis_f = vis.ravel().astype(np.float32)
    bent_f = bent.reshape(-1, 3).astype(np.float32)

    # 天光：w = 1-(1-V)²，n = normalize(mix(Bdir, N, w))，E = SkySH(n)·V
    wmix = (1.0 - (1.0 - vis_f) ** 2)[:, None].astype(np.float32)
    n = bent_f * (1.0 - wmix) + N * wmix
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-6)
    e_sky = sky_irradiance_at(sky_sh, n) * vis_f[:, None]

    out = gi * e_baked.reshape(-1, 3) + e_sky

    # 环境
    ao_term = np.clip(0.28 + 0.72 * ao.ravel(), 0.0, 1.2)
    out += np.asarray(ambient_color, np.float32)[None, :] * ambient_intensity * ao_term[:, None]

    # 太阳（定向光，走 vis_linear 的线性遮蔽）
    if sun_dir is not None and sun_intensity > 0:
        s = np.asarray(sun_dir, np.float32)
        s = s / max(float(np.linalg.norm(s)), 1e-6)
        cosn = np.clip(N @ s, 0.0, None)
        vis_s = np.clip(vfit[..., 0].ravel() + (vfit[..., 1:].reshape(-1, 3) @ s), 0.0, 1.0)
        out += np.asarray(sun_color, np.float32)[None, :] * sun_intensity * (cosn * vis_s)[:, None]

    return (base.reshape(-1, 3) * out).reshape(h, w, 3).astype(np.float32)
