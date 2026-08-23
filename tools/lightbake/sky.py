"""天空：两块东西，都在「天空」这个语义下。

1. **程序性天空的 CPU 镜像**（与 `src/rendering/lighting/skySh.ts` 同式）。
   运行时天空只以一份 SH-L2 存在；本模块把它投影成 9 个辐照度系数。
   自检 #10 钉死「三个 gain 全 0 时与旧路逐位相同」。

2. **烘焙期逃逸辐射**（`make_sky_sampler` / `resolve_sky_spec`）。
   射线跑出伪世界之后带走多少辐射，画面里没有任何东西能回答 —— 它是烘焙期的
   自由输入：纯色或 skybox（equirect）。**绝对不许从画面上取值**（历史上
   `estimate_sky_radiance` 已删，见方案 §5.3）。
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from . import const
from .encode import srgb_to_linear, to_hdr

#: 卷积系数 Â_l（Ramamoorthi & Hanrahan），l=0,1,2。
A_HAT = (math.pi, 2.0 * math.pi / 3.0, math.pi / 4.0)

#: 每个基函数对应的阶 l。
_L_OF_INDEX = (0, 1, 1, 1, 2, 2, 2, 2, 2)

#: 全球面求积密度（μ ∈ [-1,1] 均匀 + 方位均匀）。与 skySh.ts 逐位一致。
_N_ELEV = 128
_N_AZIM = 128


def sh_basis(x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
    """标准实球谐基（顺序与 `sc3SkyShIrradiance` 逐行对应）。返回 (..., 9)。"""
    return np.stack([
        0.2820948 * np.ones_like(x),
        0.4886025 * y,
        0.4886025 * z,
        0.4886025 * x,
        1.0925484 * x * y,
        1.0925484 * y * z,
        0.3153916 * (3.0 * z * z - 1.0),
        1.0925484 * x * z,
        0.5462742 * (x * x - y * y),
    ], axis=-1)


def _quad_nodes() -> tuple[np.ndarray, np.ndarray, float]:
    """全球面求积节点（μ 均匀 + φ 均匀），返回 (xyz(9,N), dΩ)。

    ⚠ 上半球节点必须与旧版逐位相同：`N_ELEV=128` 全球面时 `μ=-1+2(i+0.5)/128`
    在 `i=64..127` 上正好等于旧上半球 `N_ELEV=64` 的 `μ=(i+0.5)/64`，dΩ 也相同。
    """
    mus = -1.0 + 2.0 * (np.arange(_N_ELEV) + 0.5) / _N_ELEV
    az = 2.0 * math.pi * (np.arange(_N_AZIM) + 0.5) / _N_AZIM
    horiz = np.sqrt(np.maximum(1.0 - mus * mus, 0.0))
    xyz = []
    for mu, h in zip(mus, horiz, strict=True):
        x = h * np.sin(az)
        z = h * np.cos(az)
        y = np.full_like(x, mu)
        xyz.append(np.stack([x, y, z], axis=-1))  # (N_AZIM, 3)
    xyz = np.concatenate(xyz, axis=0).astype(np.float64)  # (N_ELEV*N_AZIM, 3)
    domega = (2.0 / _N_ELEV) * (2.0 * math.pi / _N_AZIM)
    return xyz, domega


def project_sh(radiance: np.ndarray) -> np.ndarray:
    """把球面辐亮度采样 `radiance` (N,) 投影成 9 个辐照度 SH 系数（Â_l 已乘）。

    与 `skySh.projectSh` 同式；传采样好的 `radiance(x,y,z)` 值（已按求积节点算好）。
    """
    xyz, domega = _quad_nodes()
    basis = sh_basis(xyz[:, 0], xyz[:, 1], xyz[:, 2])  # (N, 9)
    c = (basis * radiance[:, None]).sum(axis=0) * domega
    for k in range(9):
        c[k] *= A_HAT[_L_OF_INDEX[k]]
    return c


_shape_cache: dict[float, np.ndarray] = {}


def normalized_shape(profile: float) -> np.ndarray:
    """天顶剖面 `L(ω)=(ω·up)₊^profile` 的归一 SH（归一到 E(up)=1）。

    这一支是所有其余分量的标定基准：地平圈 / 辉光 / 地面反弹的 gain 都以它为 1。
    """
    key = round(profile * 1000) / 1000
    hit = _shape_cache.get(key)
    if hit is not None:
        return hit
    xyz, _ = _quad_nodes()
    # 先钳到 ≥0 再取幂，避免负底数·小数指数的 NaN 告警（np.where 会先算两边）
    up_rad = np.where(xyz[:, 1] > 0, np.maximum(xyz[:, 1], 0.0) ** key, 0.0)
    c = project_sh(up_rad)
    up = sh_basis(np.array([0.0]), np.array([1.0]), np.array([0.0]))[0]
    e_up = float(c @ up)
    out = (c / e_up if e_up > 1e-9 else c * 0.0).astype(np.float64)
    _shape_cache[key] = out
    return out


def eval_sh(coeffs: np.ndarray, x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
    """求值 `sc3SkyShIrradiance` 的 CPU 镜像。"""
    b = sh_basis(x, y, z)
    return np.maximum(b @ coeffs, 0.0)


# ---------------------------------------------------------------- kelvin
def _raw_kelvin(kelvin: float) -> tuple[float, float, float]:
    """Tanner Helland 拟合的原始输出（gamma 域，未归一）。与 kelvin.ts 严格镜像。"""
    t = min(max(kelvin, 1000.0), 40000.0) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255.0
    clamp01 = lambda v: min(max(v / 255.0, 0.0), 1.0)  # noqa: E731
    return (clamp01(r) ** 2.2, clamp01(g) ** 2.2, clamp01(b) ** 2.2)


_WHITE = _raw_kelvin(6500.0)


def kelvin_to_linear_rgb(kelvin: float) -> np.ndarray:
    v = np.asarray(_raw_kelvin(kelvin), np.float64)
    return v / np.asarray(_WHITE, np.float64)


def resolve_light_color(color, kelvin) -> np.ndarray:
    """显式 `color` 优先于 `kelvin`，都没有则白。与 kelvin.ts 同约定。"""
    if color:
        return np.asarray(color, np.float64)
    if isinstance(kelvin, (int, float)):
        return kelvin_to_linear_rgb(float(kelvin))
    return np.ones(3, np.float64)


# ---------------------------------------------------------------- 程序性天空
def is_plain_sky(sky: dict) -> bool:
    return not ((sky.get('horizonGain', 0) or 0) > 0
                or (sky.get('glowGain', 0) or 0) > 0
                or (sky.get('groundGain', 0) or 0) > 0)


def sky_irradiance_sh(sky: dict, sun_dir: np.ndarray | None = None) -> np.ndarray:
    """把程序性天空定义投影成 9 个辐照度 SH 系数（RGB 各一份 → (9,3)）。

    与 `skySh.skyIrradianceSh` 逐行对应。返回 (9,3) 便于按通道预览 / 对齐。
    """
    profile = min(max(float(sky.get('profile', 0.0)), 0.0), 4.0)
    shape = normalized_shape(profile)
    rgb = resolve_light_color(sky.get('color'), sky.get('kelvin'))
    gain = float(sky.get('intensity', 1.0))
    out = np.zeros((9, 3), np.float64)

    # 快路：旧行为（三个 gain 全 0）—— shape × color × intensity。
    if is_plain_sky(sky):
        return (shape[:, None] * rgb[None, :] * gain)

    up = sh_basis(np.array([0.0]), np.array([1.0]), np.array([0.0]))[0]
    base = float(shape @ up)
    norm = 1.0 / base if base > 1e-9 else 0.0

    out[:] = shape[:, None] * rgb[None, :] * gain

    def add(coeffs, color, g):
        if g == 0:
            return
        v = coeffs * norm * g * gain
        out[:, :] += v[:, None] * color[None, :]

    xyz, _ = _quad_nodes()

    h_gain = sky.get('horizonGain', 0) or 0
    if h_gain > 0:
        sharp = max(0.25, sky.get('horizonSharp', 3) or 3)
        rad = np.where(xyz[:, 1] > 0, (1.0 - xyz[:, 1]) ** sharp, 0.0)
        add(project_sh(rad), resolve_light_color(sky.get('horizonColor'), sky.get('horizonKelvin')), h_gain)

    g_gain = sky.get('glowGain', 0) or 0
    if g_gain > 0 and sun_dir is not None:
        s = np.asarray(sun_dir, np.float64)
        s = s / (np.linalg.norm(s) or 1.0)
        tight = max(0.25, sky.get('glowTight', 4) or 4)
        d = xyz @ s
        rad = np.where(xyz[:, 1] > 0, np.where(d > 0, d, 0.0) ** tight, 0.0)
        add(project_sh(rad), resolve_light_color(sky.get('glowColor'), sky.get('glowKelvin')), g_gain)

    gr_gain = sky.get('groundGain', 0) or 0
    if gr_gain > 0:
        rad = np.where(xyz[:, 1] < 0, 1.0, 0.0)
        add(project_sh(rad), resolve_light_color(sky.get('groundColor'), sky.get('groundKelvin')), gr_gain)

    return out


# ---------------------------------------------------------------- 烘焙期逃逸天空
def _load_skybox(path: Path) -> np.ndarray:
    """读 equirect 天空图，返回线性 HDR (h,w,3)。.hdr（RGBE）或普通 8-bit 图。"""
    if path.suffix.lower() == '.hdr':
        raw = path.read_bytes()
        nl = raw.index(b'\n\n')
        rest = raw[nl + 2:]
        eol = rest.index(b'\n')
        dims = rest[:eol].split()
        h, w = int(dims[1]), int(dims[3])
        data = np.frombuffer(rest[eol + 1:], np.uint8)
        if data.size < w * h * 4:
            raise ValueError(f'{path.name}: 只支持非 RLE 的 flat RGBE .hdr')
        rgbe = data[:w * h * 4].reshape(h, w, 4).astype(np.float32)
        f = np.where(rgbe[..., 3:4] > 0, 2.0 ** (rgbe[..., 3:4] - 136.0), 0.0)
        return (rgbe[..., :3] * f).astype(np.float32)
    img = np.asarray(Image.open(path).convert('RGB'), np.float32) / 255.0
    return to_hdr(srgb_to_linear(img))


def make_sky_sampler(spec: dict, root: Path):
    """按 spec 造 `radiance(dir_world) -> rgb` 取样器。见方案 §5.3。

    支持 `color` / `skybox` 两种。取样器能吃 (3,) 单方向也能吃 (N,3) 一批方向。
    """
    mode = spec.get('mode', 'color')
    gain = float(spec.get('intensity', 1.0))
    if mode == 'color':
        c = np.asarray(spec.get('color', [1.0, 1.0, 1.0]), np.float32) * gain

        def sample_c(dw: np.ndarray) -> np.ndarray:
            return np.broadcast_to(c, dw.shape) if dw.ndim > 1 else c
        return sample_c
    if mode == 'skybox':
        f = Path(spec['file'])
        img = (_load_skybox(f if f.is_absolute() else root / f) * gain).astype(np.float32)
        ih, iw = img.shape[:2]

        def sample_s(dw: np.ndarray) -> np.ndarray:
            a = np.atleast_2d(dw)
            u = (np.arctan2(a[:, 0], a[:, 2]) / (2.0 * math.pi) + 0.5) % 1.0
            v = np.arccos(np.clip(a[:, 1], -1.0, 1.0)) / math.pi
            out = img[np.minimum((v * ih).astype(np.int32), ih - 1),
                      np.minimum((u * iw).astype(np.int32), iw - 1)]
            return out if dw.ndim > 1 else out[0]
        return sample_s
    raise ValueError(f'未知的天空取法 {mode!r}（可选 color / skybox）')


def resolve_sky_spec(sid: str, scene_data: dict, override: dict | None = None) -> dict:
    """这个场景烘焙时用哪种逃逸辐射。优先级：CLI --sky > 场景 JSON > 缺省。"""
    if override:
        return dict(override)
    blk = (scene_data.get('lighting') or {}).get('bakeSky')
    return dict(blk) if blk else dict(const.DEFAULT_SKY)
