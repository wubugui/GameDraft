"""三条编码曲线 + 色彩 / 重采样原语 + 往返自检。

8-bit PNG 限死了动态范围，所以三条曲线是**被显式设计出来的**，不是随手选的：

1. **对数**（`base` / `irradiance` / 体数据 GI 幅度）：动态范围几百到上万倍，只有对数能全程保住相对精度；
2. **`from_hdr`（正 Reinhard）**：只用于把 8-bit 原画展开回 HDR 的逆操作，甜区仅 0.1–3；
3. **纯线性 8-bit**：只给本来就在 [0,1] 的可见性量（`V`、AO、`vis_linear`）。

⚠ **升采样必须在编码域做**，不能先解码再插值 —— 运行时 GPU 的线性过滤就作用在
纹理字节上，之后 shader 才解码；对数编码下这两条路不等价。
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from . import const


# ---------------------------------------------------------------- 色彩原语
def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """sRGB EOTF（与 `character_lighting_lab.pipeline` 同式）。x∈[0,1]。"""
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055).astype(np.float32)


def resize_f(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 单通道重采样（PIL F 模式双线性），size=(w,h)。"""
    return np.asarray(Image.fromarray(a, mode='F').resize(size, Image.BILINEAR), np.float32)


def resize_rgb(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 RGB(0..1) 重采样。"""
    u8 = a if a.dtype == np.uint8 else np.round(np.clip(a, 0, 1) * 255).astype(np.uint8)
    return np.asarray(Image.fromarray(u8).resize(size, Image.BILINEAR), np.float32) / 255.0


# ---------------------------------------------------------------- HDR 展开
def to_hdr(lin: np.ndarray) -> np.ndarray:
    """线性化的 8-bit 原画 → HDR 辐射场（逆 Reinhard）。

    原画就是出射辐射的图，但 8-bit 把高光压掉了：线性化后灶口和白墙都贴 1.0，
    而真实辐射差两个数量级。假设按 `y = x/(1+x)` 压过，逆映射 `x = y/(1-y)`，
    分母加下限 `1/HDR_MAX`。中间调几乎不动（y=0.2→0.25），高光被拉开（y=0.9→10）。

    ⚠ 这是整条链唯一的建模假设，其余全是积分。
    """
    return (lin / np.maximum(1.0 - lin, 1.0 / const.HDR_MAX)).astype(np.float32)


def from_hdr(x: np.ndarray) -> np.ndarray:
    """`to_hdr` 的逆（Reinhard 正向），只用于往返自检与预览。"""
    return (x / (1.0 + x)).astype(np.float32)


# ---------------------------------------------------------------- 对数编码
def pick_log_params(x: np.ndarray, one_sided: bool = False) -> tuple[float, float]:
    """给一批非负 HDR 值挑对数编码的 (scale, span)，**按数据定、保证不饱和**。

    `one_sided=True` 用于比例基底 `base`：它有物理上界 1，把 1.0 钉在量程上端、
    往下覆盖到数据下界。其余载荷取几何中点居中。
    """
    pos = x[x > 0]
    if pos.size == 0:
        return 1.0, const.HDR_LOG_SPAN_MIN
    hi = 1.0 if one_sided else float(pos.max())
    lo = float(np.percentile(pos, const.HDR_LOG_FLOOR_PCT))
    lo = min(max(lo, hi * 2.0 ** -const.HDR_LOG_SPAN_MAX), hi)
    span = float(np.clip(math.ceil(math.log2(hi / max(lo, 1e-30))),
                         const.HDR_LOG_SPAN_MIN, const.HDR_LOG_SPAN_MAX))
    scale = hi * 2.0 ** (-span / 2.0) if one_sided else float(math.sqrt(lo * hi))
    return scale, span


def encode_log_hdr(x: np.ndarray, scale: float, span: float) -> np.ndarray:
    """HDR → u8 对数编码。`scale` 落在量程正中（字节 127.5）。"""
    v = np.log2(np.maximum(x, 1e-30) / max(scale, 1e-30)) / span + 0.5
    return np.round(np.clip(v, 0.0, 1.0) * 255.0).astype(np.uint8)


def decode_log_hdr(u8: np.ndarray, scale: float, span: float) -> np.ndarray:
    return (scale * np.exp2((u8.astype(np.float32) / 255.0 - 0.5) * span)).astype(np.float32)


def decode_base(u8: np.ndarray, scale: float, span: float) -> np.ndarray:
    """比例基底的解码。与 `decode_log_hdr` 只差一条：**字节 0 表示精确的 0**。

    ⚠ 不是修饰。`base` 的下端会真的撞到编码下限（极亮场景 E 到 1000 量级，
    近黑像素 hdr/E 能小到 5e-6）。抬到下限后 base·E 已经超过原画，画面本该全黑
    的地方发灰。
    """
    return decode_log_hdr(u8, scale, span) * (u8 > 0)


def resize_encoded(u8: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """对**编码字节**做双线性升采样，返回浮点字节值（还没解码）。

    ⚠ 必须在编码域插值，不能先解码再插值 —— 运行时就是这么做的（GPU 线性过滤
    作用在字节上，shader 之后才解码）。对数编码下编码域线性插值 = 线性域几何平均。
    """
    return np.stack([resize_f(np.ascontiguousarray(u8[..., c].astype(np.float32)), size)
                     for c in range(u8.shape[-1])], -1)


# ---------------------------------------------------------------- 往返自检
def roundtrip_log(x: np.ndarray, one_sided: bool = False) -> dict:
    """对数编码往返：编 → 解，比相对误差 p99。返回诊断 dict。"""
    scale, span = pick_log_params(x, one_sided)
    enc = encode_log_hdr(x, scale, span)
    dec = (decode_base(enc, scale, span) if one_sided
           else decode_log_hdr(enc, scale, span))
    denom = np.maximum(np.abs(x), 1e-9)
    err = np.abs(dec - x) / denom
    return {
        'scale': scale, 'span': span,
        'p99_rel': float(np.percentile(err, 99)),
        'max_rel': float(err.max()),
        'enc': enc, 'dec': dec,
    }


def roundtrip_visibility(x: np.ndarray) -> dict:
    """纯线性 8-bit 往返（可见性量 [0,1]）。误差以 1/255 计。"""
    enc = np.round(np.clip(x, 0.0, 1.0) * 255.0).astype(np.uint8)
    dec = enc.astype(np.float32) / 255.0
    err = np.abs(dec - x) * 255.0
    return {
        'p99_255': float(np.percentile(err, 99)),
        'max_255': float(err.max()),
        'enc': enc, 'dec': dec,
    }
