"""天空的两件事,刻意分开(§5.3 / §7):

1. **烘焙期逃逸辐射**(`make_sky_sampler`):射线跑出伪世界带走的辐射。
   纯色或 skybox,在 GUI 里边调边看、存回场景 JSON `lighting.bakeSky`,
   **不进运行时载荷**。绝对不许从画面上取值(§5.3 的历史教训)。
2. **运行时程序性天空的 CPU 镜像**:与 `src/rendering/lighting/skySh.ts` 同式
   (SH-L2 辐照度投影),给 report 面板与自检 #10 用。
   三个 gain 全为 0 时逐位回到旧行为(快路),28 个场景一个字不用改。
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from .encode import srgb_to_linear, to_hdr

# ================================================ 烘焙期逃逸辐射 §5.3

def load_skybox(path: Path) -> np.ndarray:
    """读一张 equirect(lat-long)天空图,返回线性 HDR 的 (h,w,3)。

    `.hdr`(Radiance RGBE,仅 flat 非 RLE)自己解,普通 8-bit 图走
    sRGB→线性→逆 Reinhard(与原画同一条展开)。
    """
    if path.suffix.lower() == '.hdr':
        raw = path.read_bytes()
        try:
            nl = raw.index(b'\n\n')
        except ValueError as exc:
            raise ValueError(f'{path.name}: 不是合法 Radiance HDR(无头部空行)'
                             ) from exc
        rest = raw[nl + 2:]
        eol = rest.index(b'\n')
        dims = rest[:eol].split()
        # 只接受标准 `-Y H +X W` 轴序:其余轴序会静默转置/上下翻,拒绝猜
        if len(dims) != 4 or dims[0] != b'-Y' or dims[2] != b'+X':
            raise ValueError(f'{path.name}: 分辨率行 {rest[:eol]!r} 非标准 '
                             f'-Y H +X W 轴序,暂不支持')
        h, w = int(dims[1]), int(dims[3])
        data = np.frombuffer(rest[eol + 1:], np.uint8)
        # new-style RLE 扫描线头是 02 02 (w>>8) (w&0xff) —— 显式探测拒绝。
        # ⚠ 不能只靠尺寸判:RLE 对不可压数据会**膨胀**,单边 `<` 挡不住,
        #   会把 RLE 字节流当 flat 解出 1e19 量级的假辐射(审查纠正)。
        if data.size >= 4 and data[0] == 2 and data[1] == 2 \
                and (int(data[2]) << 8 | int(data[3])) == w:
            raise ValueError(f'{path.name}: RLE 压缩的 .hdr 暂不支持 —— '
                             f'导出为非压缩(flat)RGBE,或用 8-bit 图')
        if data.size < w * h * 4:
            raise ValueError(f'{path.name}: 数据不足 flat RGBE 尺寸 '
                             f'({data.size} < {w * h * 4})')
        rgbe = data[:w * h * 4].reshape(h, w, 4).astype(np.float32)
        # 尾数刻意**不加** Radiance 参考实现的 +0.5 偏置 —— 与被替换的现役
        # 实现同口径;要改就得连既有素材一起重标定。
        f = np.where(rgbe[..., 3:4] > 0, 2.0 ** (rgbe[..., 3:4] - 136.0), 0.0)
        return (rgbe[..., :3] * f).astype(np.float32)
    img = np.asarray(Image.open(path).convert('RGB'), np.float32) / 255.0
    return to_hdr(srgb_to_linear(img))


def make_sky_sampler(spec: dict, root: Path):
    """按 spec 造 `radiance(dirs_world) -> rgb` 的取样器。

    `{'mode':'color','color':[r,g,b],'intensity':k}` 或
    `{'mode':'skybox','file':'...','intensity':k}`。
    取样器要能吃 (3,) 单方向也能吃 (n,3) 一批 —— MC 每根光线方向都不同。
    ⚠ 契约:方向必须已单位化;返回值只读(常色分支返回 broadcast 视图),
      消费者要改就自己拷。
    """
    mode = spec.get('mode', 'color')
    gain = float(spec.get('intensity', 1.0))
    if mode == 'color':
        c = (np.asarray(spec.get('color', [1.0, 1.0, 1.0]), np.float32) * gain
             ).astype(np.float32)
        c.flags.writeable = False          # 与 constant_rgb 共享,禁原地改

        def sample_c(dw: np.ndarray) -> np.ndarray:
            return np.broadcast_to(c, dw.shape) if dw.ndim > 1 else c
        # 常色标记:方向无关 ⇒ 逃逸半 = 逃逸计数 × 常色,重估免重生成方向(§5.12)
        sample_c.constant_rgb = c
        return sample_c
    if mode == 'skybox':
        f = Path(spec['file'])
        img = (load_skybox(f if f.is_absolute() else root / f) * gain
               ).astype(np.float32)
        ih, iw = img.shape[:2]

        def sample_s(dw: np.ndarray) -> np.ndarray:
            a = np.atleast_2d(dw)
            u = (np.arctan2(a[:, 0], a[:, 2]) / (2.0 * math.pi) + 0.5) % 1.0
            v = np.arccos(np.clip(a[:, 1], -1.0, 1.0)) / math.pi
            out = img[np.minimum((v * ih).astype(np.int32), ih - 1),
                      np.minimum((u * iw).astype(np.int32), iw - 1)]
            return out if dw.ndim > 1 else out[0]
        return sample_s
    raise ValueError(f'未知的天空取法 {mode!r}(可选 color / skybox)')


# ===================================== 运行时天空 SH 的 CPU 镜像 §7

#: 卷积系数 Â_l(Ramamoorthi & Hanrahan),l = 0,1,2。
A_HAT = (math.pi, 2.0 * math.pi / 3.0, math.pi / 4.0)
_L_OF_INDEX = (0, 1, 1, 1, 2, 2, 2, 2, 2)

#: 求积密度(与 skySh.ts 逐字同值)。μ ∈ [-1,1] 均匀 ⇒ 上半球节点与
#: 旧版上半球 N_ELEV=64 逐位相同(§7.3,已验证)。
N_ELEV = 128
N_AZIM = 128


def sh_basis(x, y, z):
    """标准实球谐基,顺序与 `sc3SkyShIrradiance` 逐行对应。标量或数组皆可。"""
    return np.stack([
        np.broadcast_to(np.float64(0.2820948), np.shape(x)) if np.ndim(x) else np.float64(0.2820948),
        0.4886025 * y,
        0.4886025 * z,
        0.4886025 * x,
        1.0925484 * x * y,
        1.0925484 * y * z,
        0.3153916 * (3.0 * z * z - 1.0),
        1.0925484 * x * z,
        0.5462742 * (x * x - y * y),
    ]) if np.ndim(x) else np.array([
        0.2820948,
        0.4886025 * y, 0.4886025 * z, 0.4886025 * x,
        1.0925484 * x * y, 1.0925484 * y * z,
        0.3153916 * (3.0 * z * z - 1.0),
        1.0925484 * x * z, 0.5462742 * (x * x - y * y),
    ], np.float64)


def _quad_nodes() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """全球面求积节点(展平)。μ 均匀、φ 均匀,与 skySh.ts 的双循环同序展平。"""
    i = np.arange(N_ELEV, dtype=np.float64)
    mu = -1.0 + (2.0 * (i + 0.5)) / N_ELEV
    horiz = np.sqrt(np.maximum(1.0 - mu * mu, 0.0))
    j = np.arange(N_AZIM, dtype=np.float64)
    a = (2.0 * math.pi * (j + 0.5)) / N_AZIM
    x = horiz[:, None] * np.sin(a)[None, :]
    z = horiz[:, None] * np.cos(a)[None, :]
    y = np.broadcast_to(mu[:, None], x.shape)
    return x.ravel(), y.ravel(), z.ravel()


_QX, _QY, _QZ = _quad_nodes()
_QBASIS = sh_basis(_QX, _QY, _QZ)          # (9, N) float64


def project_sh(radiance) -> np.ndarray:
    """任意球面剖面 → 9 个辐照度 SH 系数(Â_l 已乘进去)。

    radiance(x, y, z) 吃展平数组、回同形数组。积整个球面
    (下半球装地面反弹;groundGain=0 时下半球恒 0 ⇒ 与旧版逐位相同)。
    """
    rad = np.asarray(radiance(_QX, _QY, _QZ), np.float64)
    c = _QBASIS @ rad
    d_omega = (2.0 / N_ELEV) * (2.0 * math.pi / N_AZIM)
    for k in range(9):
        c[k] *= d_omega * A_HAT[_L_OF_INDEX[k]]
    return c


_shape_cache: dict[float, np.ndarray] = {}


def normalized_shape(profile: float) -> np.ndarray:
    """天顶剖面 `(ω·up)₊^profile`,归一到 E(up) = 1 —— 其余分量的标定基准。"""
    # 与 TS `Math.round`(.5 向上)同语义;python 内建 round 是银行家舍入,
    # 在恰好 .5 的键上会与镜像分叉(审查纠正)。
    key = math.floor(profile * 1000.0 + 0.5) / 1000.0
    hit = _shape_cache.get(key)
    if hit is not None:
        return hit
    c = project_sh(lambda x, y, z: np.where(y > 0, np.maximum(y, 0.0) ** key, 0.0))
    e_up = float(c @ sh_basis(0.0, 1.0, 0.0))
    out = c * (1.0 / e_up if e_up > 1e-9 else 0.0)
    _shape_cache[key] = out
    return out


def eval_sh(coeffs: np.ndarray, x: float, y: float, z: float):
    """求值(sc3SkyShIrradiance 的同式)。coeffs (9,) 或 (9,3)。"""
    b = sh_basis(float(x), float(y), float(z))
    e = b @ coeffs if coeffs.ndim == 1 else (coeffs * b[:, None]).sum(0)
    return np.maximum(e, 0.0)


# ------------------------------------------------ 色温(kelvin.ts 严格镜像)

def _raw_kelvin(kelvin: float) -> np.ndarray:
    t = min(max(kelvin, 1000.0), 40000.0) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255.0
    v = np.clip(np.array([r, g, b], np.float64) / 255.0, 0.0, 1.0)
    return v ** 2.2         # 2.2 幂近似线性化(两边必须一致,刻意不用精确 sRGB)


_WHITE = _raw_kelvin(6500.0)


def kelvin_to_linear_rgb(kelvin: float) -> np.ndarray:
    return _raw_kelvin(kelvin) / _WHITE


def resolve_light_color(color=None, kelvin=None) -> np.ndarray:
    if color is not None:
        return np.asarray(color, np.float64)
    if kelvin is not None:
        return kelvin_to_linear_rgb(float(kelvin))
    return np.ones(3, np.float64)


def sky_radiance(sky: dict, dirs: np.ndarray, sun_dir=None) -> np.ndarray:
    """程序性天空的**辐亮度**剖面 L(ω)(§7.2 逐式;report 面板 5 的
    「天穹辐亮度球」用 —— 与投影进 SH 的是同一被积函数,天顶瓣未归一,
    展示按峰值归一即可)。dirs (n,3) 单位方向 → (n,3) 线性 RGB。"""
    d = np.atleast_2d(np.asarray(dirs, np.float64))
    mu = d[:, 1]
    profile = max(0.0, min(4.0, float(sky.get('profile') or 0.0)))
    gain = float(sky.get('intensity', 0.0))
    out = np.zeros((len(d), 3))
    up_m = mu > 0
    zen = resolve_light_color(sky.get('color'), sky.get('kelvin'))
    out[up_m] += np.maximum(mu[up_m], 0.0)[:, None] ** profile * zen[None, :]
    h_gain = float(sky.get('horizonGain') or 0.0)
    if h_gain > 0:
        sharp = max(0.25, float(sky.get('horizonSharp') or 3.0))
        c = resolve_light_color(sky.get('horizonColor'), sky.get('horizonKelvin'))
        out[up_m] += h_gain * (1.0 - mu[up_m])[:, None] ** sharp * c[None, :]
    g_gain = float(sky.get('glowGain') or 0.0)
    if g_gain > 0 and sun_dir is not None:
        s = np.asarray(sun_dir, np.float64)
        s = s / (np.linalg.norm(s) or 1.0)
        tight = max(0.25, float(sky.get('glowTight') or 4.0))
        c = resolve_light_color(sky.get('glowColor'), sky.get('glowKelvin'))
        dd = np.maximum(d[up_m] @ s, 0.0)
        out[up_m] += g_gain * dd[:, None] ** tight * c[None, :]
    gr_gain = float(sky.get('groundGain') or 0.0)
    if gr_gain > 0:
        c = resolve_light_color(sky.get('groundColor'), sky.get('groundKelvin'))
        out[~up_m] = gr_gain * c[None, :]
    return out * gain


# ------------------------------------------------------ 完整剖面 §7.2

def sky_irradiance_sh(sky: dict, sun_dir=None) -> np.ndarray:
    """`skySh.ts::skyIrradianceSh` 的镜像,返回 (9,3) float64(RGB 系数)。

    三个 gain 全 0 时走快路,与旧行为逐位相同(自检 #10 的被测物)。
    """
    profile = max(0.0, min(4.0, float(sky.get('profile') or 0.0)))
    shape = normalized_shape(profile)
    rgb = resolve_light_color(sky.get('color'), sky.get('kelvin'))
    gain = float(sky.get('intensity', 0.0))
    h_gain = float(sky.get('horizonGain') or 0.0)
    g_gain = float(sky.get('glowGain') or 0.0)
    gr_gain = float(sky.get('groundGain') or 0.0)

    out = shape[:, None] * rgb[None, :] * gain      # 天顶剖面(快路与慢路同一句)
    if h_gain <= 0 and g_gain <= 0 and gr_gain <= 0:
        return out

    up_b = sh_basis(0.0, 1.0, 0.0)
    base = float(shape @ up_b)
    norm = 1.0 / base if base > 1e-9 else 0.0

    def add(coeffs: np.ndarray, color: np.ndarray, g: float) -> None:
        nonlocal out
        if g == 0:
            return
        out = out + (coeffs * norm * g * gain)[:, None] * color[None, :]

    if h_gain > 0:
        sharp = max(0.25, float(sky.get('horizonSharp') or 3.0))
        add(project_sh(lambda x, y, z: np.where(y > 0, (1.0 - y) ** sharp, 0.0)),
            resolve_light_color(sky.get('horizonColor'), sky.get('horizonKelvin')),
            h_gain)
    if g_gain > 0 and sun_dir is not None:
        sx, sy, sz = float(sun_dir[0]), float(sun_dir[1]), float(sun_dir[2])
        ln = math.hypot(sx, sy, sz) or 1.0
        ux, uy, uz = sx / ln, sy / ln, sz / ln
        tight = max(0.25, float(sky.get('glowTight') or 4.0))
        add(project_sh(lambda x, y, z: np.where(
                (y > 0) & (x * ux + y * uy + z * uz > 0),
                np.maximum(x * ux + y * uy + z * uz, 0.0) ** tight, 0.0)),
            resolve_light_color(sky.get('glowColor'), sky.get('glowKelvin')),
            g_gain)
    if gr_gain > 0:
        add(project_sh(lambda x, y, z: np.where(y < 0, 1.0, 0.0)),
            resolve_light_color(sky.get('groundColor'), sky.get('groundKelvin')),
            gr_gain)
    return out
