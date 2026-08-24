"""三条编码曲线 + 色彩转换 + 编码域重采样(方案 §4.3 / §5.10)。

三条曲线是被显式设计出来的,不是随手选的:

1. **对数**(`irradiance` / 体数据 GI 幅度):动态范围几百到上万倍;
2. **`from_hdr`(正 Reinhard)**:只用于把 8-bit 原画展开成 HDR,甜区仅 0.1–3;
3. **纯线性 8-bit**:只给本来就有界的可见性量(遮蔽矩、AO)。

⚠ `one_sided` / `decode_base` 已随 base 不落盘一并废除(§5.10):
   base 不量化,这两个当年要解决的问题不存在了。
⚠ 升采样必须在**编码域**做(`resize_encoded`),不能解码后插值再编码 ——
   运行时 GPU 的线性过滤就作用在纹理字节上。
"""
from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

from .const import HDR_LOG_FLOOR_PCT, HDR_LOG_SPAN_MAX, HDR_LOG_SPAN_MIN, HDR_MAX

# ------------------------------------------------------------------ 色彩

def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """sRGB EOTF。x∈[0,1]。"""
    return np.where(x <= 0.04045, x / 12.92,
                    ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92,
                    1.055 * x ** (1 / 2.4) - 0.055).astype(np.float32)


#: Rec.709 亮度权重(与 shadeCore3 的 LC_LUMA 同值)。
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


# ------------------------------------------------------------- HDR 展开

def to_hdr(lin: np.ndarray) -> np.ndarray:
    """逆 Reinhard:`x = y / max(1-y, 1/HDR_MAX)`。整条链唯一的建模假设(§5.2)。

    ⚠ 运行时的 `tonemap: reinhard` 是它的精确反函数 —— 这是
      `gi=1 ⇒ 画面精确等于原画` 成立的机制。换 tonemap 必须同时换这里并全量重烘。
    """
    return (lin / np.maximum(1.0 - lin, 1.0 / HDR_MAX)).astype(np.float32)


def from_hdr(x: np.ndarray) -> np.ndarray:
    """正 Reinhard(`to_hdr` 的逆),用于往返自检与预览(与 sc3FromHdr 同式)。"""
    return (x / (1.0 + x)).astype(np.float32)


# ------------------------------------------------------------- 对数编码

def pick_log_params(x: np.ndarray) -> tuple[float, float]:
    """给一批非负 HDR 值挑对数编码的 (scale, span),按数据定、保证不饱和(§5.10)。"""
    pos = x[x > 0]
    if pos.size == 0:
        return 1.0, HDR_LOG_SPAN_MIN
    hi = float(pos.max())
    lo = float(np.percentile(pos, HDR_LOG_FLOOR_PCT))
    lo = min(max(lo, hi * 2.0 ** -HDR_LOG_SPAN_MAX), hi)
    span = float(np.clip(math.ceil(math.log2(hi / max(lo, 1e-30))),
                         HDR_LOG_SPAN_MIN, HDR_LOG_SPAN_MAX))
    scale = float(math.sqrt(lo * hi))
    return scale, span


def encode_log_hdr(x: np.ndarray, scale: float, span: float) -> np.ndarray:
    """HDR → u8 对数编码。`scale` 落在量程正中(字节 127.5)。"""
    v = np.log2(np.maximum(x, 1e-30) / max(scale, 1e-30)) / span + 0.5
    return np.round(np.clip(v, 0.0, 1.0) * 255.0).astype(np.uint8)


def decode_log_hdr(u8: np.ndarray, scale: float, span: float) -> np.ndarray:
    """与 GLSL 侧 `sc3DecodeLogHdr` 同式:`x = scale · 2^((u8/255 − ½)·span)`。"""
    return (scale * np.exp2((u8.astype(np.float32) / 255.0 - 0.5) * span)
            ).astype(np.float32)


# ------------------------------------------------------------ 线性 8-bit

def encode_unit(x: np.ndarray) -> np.ndarray:
    """[0,1] 有界量 → 线性 u8(遮蔽矩、AO)。"""
    return np.round(np.clip(x, 0.0, 1.0) * 255.0).astype(np.uint8)


def decode_unit(u8: np.ndarray) -> np.ndarray:
    return (u8.astype(np.float32) / 255.0).astype(np.float32)


# ----------------------------------------------------- 遮蔽矩的固定编码

def encode_moments(a0: np.ndarray, a1: np.ndarray) -> np.ndarray:
    """遮蔽矩 (a₀, a₁) → RGBA8:`R = 2·a₀`,`GBA = a₁ + ½`(§4.2,固定编码)。

    a₀∈[0,½]、a₁ 分量∈[−½,½] —— 上半球均匀测度下的解析值域,无逐场景 scale。
    场景 `sky_moments.png` 与体数据通道 0 逐字同一套。
    """
    out = np.empty(a0.shape + (4,), np.uint8)
    out[..., 0] = encode_unit(a0 * 2.0)
    out[..., 1:] = encode_unit(a1 + 0.5)
    return out


def decode_moments(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    a0 = decode_unit(rgba[..., 0]) * 0.5
    a1 = decode_unit(rgba[..., 1:]) - 0.5
    return a0, a1


# ------------------------------------------------------------- 重采样

def resize_f(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 单通道重采样(PIL F 双线性),size=(w,h)。"""
    return np.asarray(Image.fromarray(a, mode='F').resize(size, Image.BILINEAR),
                      np.float32)


def resize_rgb(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 RGB(0..1) 重采样。"""
    u8 = a if a.dtype == np.uint8 else np.round(np.clip(a, 0, 1) * 255).astype(np.uint8)
    return np.asarray(Image.fromarray(u8).resize(size, Image.BILINEAR),
                      np.float32) / 255.0


def resize_encoded(u8: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """对**编码字节**做双线性升采样,返回浮点字节值(还没解码)。

    ⚠ 必须在编码域插值:运行时 GPU 的线性过滤作用在纹理字节上、之后 shader 才
    解码,对数编码下「先解码再插值」与它不等价(编码域线性插值 = 线性域几何平均)。
    烘焙侧若走另一条路,据 E 反推的 base 就与运行时实际拿到的 E 对不上,
    而往返指标测不出来(§4.3)。
    """
    if u8.ndim == 2:
        return resize_f(np.ascontiguousarray(u8.astype(np.float32)), size)
    return np.stack([resize_f(np.ascontiguousarray(u8[..., c].astype(np.float32)), size)
                     for c in range(u8.shape[-1])], -1)


# ---------------------------------------------------------------- PNG

def png_bytes(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, format='PNG', optimize=True)
    return buf.getvalue()
