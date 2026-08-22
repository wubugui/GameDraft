"""确定性重打光核心(纯 numpy,零随机,同输入必出同字节)。

方法(2026-08-20 制作人验收口径,三件事按承重顺序):
  ① 天穹可见性:逐像素向上半球 12 方向 march 深度场(`sky_field`)——巷道/檐下真遮蔽;
  ② 定向光(日/月)投影:沿光方向 march 深度场(`screen_shadow`);
  ③ 先除掉白天光、再乘上新光(只是最后一步算术,S_day 与 S_new 都由 ①② 构成):
       out = bg_linear × clamp(S_new / S_day, 0, ratio_max)
⚠ 别把 ③ 当成方法的名字。**被否**:S_day/S_new 只用法线朝上项、不做 march 的写法
  ——那是逐像素调色,画不出遮蔽结构,看着就是贴滤镜。
S_new = 环境半球光(经天穹可见性) + 定向光(太阳/月亮同一槽)×N·L×深度场投影;
之后叠:手绘发光 mask 的灯体/光晕/地面光池 → 湿地 → 深度雾 → 调色 → sRGB。
结构 100% 不变(逐像素纯映射 + 定值卷积),这是"稳定可 ship"的根。

参数全部平铺在一个 dict(DEFAULTS),预设=参数补丁;未知键一律拒绝,
预设文件打错字不会静默变成"用默认值"。
"""
from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import gaussian_filter

from .geometry import Scene, linear_to_srgb, resize_rgb, srgb_to_linear

DEFAULTS: dict[str, float] = {
    # ---- 白天参考光(S_day 的半球权重;动它=重新解释原图,一般不动) ----
    'day_hemi': 0.35,
    # ---- 环境(天穹)光 ----
    'amb_int': 1.0, 'amb_kelvin': 6500.0, 'amb_hemi': 0.35,
    # ---- 定向光(太阳/月亮) ----
    'sun_int': 0.0, 'sun_elev': 35.0, 'sun_azim': 210.0, 'sun_kelvin': 5200.0,
    # ---- 阴影(需要深度) ----
    'shadow_strength': 0.85, 'shadow_len': 2.5, 'shadow_steps': 48.0,
    'shadow_soft': 2.0, 'shadow_bias': 0.035, 'occ_thick': 2.0,
    # ---- 发光体(手绘 mask,白=发光):mask 团 → 伪世界点光源 ----
    'emis_gain': 0.0,        # 灯体自身亮度
    'emis_kelvin': 2000.0,   # 灯光色温
    'lamp_int': 0.0,         # 点光源强度(N·L/r² 打到周围几何上)
    'lamp_h': 0.22,          # 光源从表面朝相机抬起的距离(wu,防自遮挡)
    'lamp_falloff': 0.25,    # 1/(r²+c) 的 c,近处软化
    'lamp_clamp': 1.5,       # 单灯入射光上限(防近场核爆)
    'lamp_range': 1.6,       # 作用半径(wu):高斯截断,灯光池收得住,冷夜基调才立得住
    'lamp_vis': 1.0,         # 1=灯光沿深度场做可见性(被墙挡),0=不遮挡
    'lamp_sat': 0.65,        # 灯色吃原图像素色的比例(红灯笼发红光)
    'lamp_maxn': 24.0,       # 最多提取几盏灯(按通量取大)
    'glow_radius': 6.0, 'glow_gain': 0.9,   # 大气光晕(加性 bloom,仅灯体周围)
    # ---- 深度雾(fog_start 按场景深度范围归一 0..1) ----
    'fog_density': 0.0, 'fog_start': 0.0, 'fog_kelvin': 7500.0, 'fog_lum': 0.35,
    'fog_y': 0.5, 'fog_fall': 0.0,
    # ---- 湿地(雨) ----
    'wet': 0.0, 'sheen': 0.0,
    # ---- 调色 ----
    'ev': 0.0, 'contrast': 1.0, 'sat': 1.0, 'grade_kelvin': 6500.0,
    'lift': 0.0, 'lift_kelvin': 9000.0,
    # ---- 稳定护栏 ----
    'ratio_max': 6.0, 'keep_src': 0.0,
}

def merge_params(*patches: dict | None) -> dict:
    """DEFAULTS ← 补丁序列。未知键直接抛——预设打错字不许静默吞。"""
    p = dict(DEFAULTS)
    for patch in patches:
        if not patch:
            continue
        unknown = set(patch) - set(DEFAULTS)
        if unknown:
            raise KeyError(f'未知重打光参数: {sorted(unknown)}')
        for k, v in patch.items():
            p[k] = float(v)
    return p


def kelvin_rgb(k: float) -> np.ndarray:
    """色温→线性 RGB,6500K 归一为 (1,1,1)(Tanner Helland 近似)。"""
    def raw(t: float) -> np.ndarray:
        t = min(max(t, 1000.0), 40000.0) / 100.0
        if t <= 66:
            r = 255.0
            g = 99.4708025861 * math.log(t) - 161.1195681661
            b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
        else:
            r = 329.698727446 * (t - 60) ** -0.1332047592
            g = 288.1221695283 * (t - 60) ** -0.0755148492
            b = 255.0
        v = np.clip(np.array([r, g, b], np.float64) / 255.0, 0.0, 1.0)
        return v ** 2.2                      # 近似线性化
    v = raw(k) / raw(6500.0)
    return v.astype(np.float32)


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def sun_dir(elev_deg: float, azim_deg: float) -> np.ndarray:
    """指向光源的世界方向。azim 0°=光从画面正前(+z 深处)射来,90°=从画面右侧。"""
    e = math.radians(elev_deg)
    a = math.radians(azim_deg)
    return np.array([math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)],
                    np.float32)


def _march_blocked(geo: dict, L: np.ndarray, steps: int, length: float,
                   bias0: float, thick: float) -> np.ndarray:
    """沿世界方向 L march 深度场:落到可见壳背后(且在 thick 厚度窗内)即判挡。
    返回 bool (h,w)。确定性:定步长,无抖动。"""
    d = geo['depth']
    h, w = d.shape
    R, ppu = geo['R'], geo['ppu']
    Lq = R.T @ L                                   # world → q(R 正交)
    step = length / max(steps, 1)
    dpx = float(Lq[0] * ppu * step)
    dpy = float(-Lq[1] * ppu * step)
    dd = float(Lq[2] * step)
    px0 = np.arange(w, dtype=np.float32)[None, :]
    py0 = np.arange(h, dtype=np.float32)[:, None]
    blocked = np.zeros((h, w), bool)
    for i in range(1, steps + 1):
        px = px0 + dpx * i
        py = py0 + dpy * i
        z = d + dd * i
        inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        xi = np.clip(px, 0, w - 1).astype(np.int32)
        yi = np.clip(py, 0, h - 1).astype(np.int32)
        pen = z - d[yi, xi]
        bias = bias0 + 0.02 * step * i
        blocked |= inside & (pen > bias) & (pen < thick)
    return blocked


def screen_shadow(geo: dict, L: np.ndarray, p: dict, px_scale: float) -> np.ndarray:
    """定向光(太阳/月亮)投影。返回 [0,1] 阴影系数(1=全亮)。"""
    blocked = _march_blocked(geo, L, max(int(p['shadow_steps']), 4), p['shadow_len'],
                             p['shadow_bias'], p['occ_thick'])
    shadow = 1.0 - blocked.astype(np.float32)
    soft = p['shadow_soft'] * px_scale
    if soft > 0:
        shadow = gaussian_filter(shadow, soft)
    return 1.0 - p['shadow_strength'] * (1.0 - np.clip(shadow, 0.0, 1.0))


#: 天穹采样方向(固定、确定):6 方位 × 2 仰角。改这组常量会使全部缓存失效性地
#: 改变光照结果,等同改算法版本。
_SKY_ELEVS = (28.0, 58.0)
_SKY_AZIMS = (0.0, 60.0, 120.0, 180.0, 240.0, 300.0)


def sky_field(geo: dict, px_scale: float) -> np.ndarray:
    """天穹辐照场 E_sky(x) ∈ [0,~1]:12 个上半球方向逐像素 march 遮蔽,
    E = Σ vis_d·max(N·d,0) / Σ max(up·d,0)——开阔平地=1,巷道/屋檐下/立面按
    真实遮蔽与朝向衰减。**这是"重打光"区别于"调色"的核心场**:同一份几何,
    白天光除掉它、夜光重乘它(权重不同),光的空间结构才会真的变。
    只依赖几何,按分辨率缓存进 geo(首算几秒,之后零成本)。"""
    hit = geo.get('sky_e')
    if hit is not None:
        return hit
    N = geo['normal']
    h, w = geo['depth'].shape
    E = np.zeros((h, w), np.float32)
    norm = 0.0
    for elev in _SKY_ELEVS:
        for azim in _SKY_AZIMS:
            dvec = sun_dir(elev, azim)
            vis = 1.0 - _march_blocked(geo, dvec, steps=16, length=2.2,
                                       bias0=0.05, thick=2.0).astype(np.float32)
            E += vis * np.clip(N @ dvec, 0.0, 1.0)
            norm += max(float(dvec[1]), 0.0)
    E /= max(norm, 1e-6)
    E = gaussian_filter(E, max(1.0, 1.0 * px_scale))
    geo['sky_e'] = np.clip(E, 0.0, 1.5)
    return geo['sky_e']


def extract_lamps(mask: np.ndarray, geo: dict, bg_lin: np.ndarray, p: dict) -> list[dict]:
    """发光 mask 连通域 → 伪世界点光源(位置/强度/颜色)。

    - 位置:团质心像素反投影到世界,再朝相机抬 lamp_h(防灯体自遮挡);
    - 强度:∝ 团的世界面积(通量/ppu²,分辨率不变量);
    - 颜色:色温 × 原图像素色(lamp_sat 控比例)——红灯笼发红光。
    """
    from scipy.ndimage import center_of_mass, label
    from scipy.ndimage import sum as nd_sum
    lab, n = label(mask > 0.15)
    if n == 0:
        return []
    idx = np.arange(1, n + 1)
    flux = np.atleast_1d(nd_sum(mask, lab, index=idx))
    order = np.argsort(flux)[::-1][:int(p['lamp_maxn'])]
    coms = center_of_mass(mask, lab, index=idx[order].tolist())
    R, ppu, cx, cy = geo['R'], geo['ppu'], geo['cx'], geo['cy']
    d = geo['depth']
    h, w = d.shape
    cam_dir = R @ np.array([0.0, 0.0, 1.0], np.float32)     # 指向场景深处
    emis_rgb = kelvin_rgb(p['emis_kelvin'])
    lamps = []
    for k, (py, px) in enumerate(np.atleast_2d(coms)):
        yi, xi = int(np.clip(py, 0, h - 1)), int(np.clip(px, 0, w - 1))
        q = np.array([(px - cx) / ppu, (cy - py) / ppu, d[yi, xi]], np.float32)
        pos = R @ q - cam_dir * p['lamp_h']
        sel = lab == idx[order][k]
        col = bg_lin[sel].mean(axis=0)                       # 团的原图平均色
        chroma = col / max(float(col.mean()), 1e-4)
        rgb = emis_rgb * ((1.0 - p['lamp_sat']) + p['lamp_sat'] * chroma)
        area_wu = float(flux[order[k]]) / (ppu * ppu)        # 世界面积,分辨率不变
        lamps.append({'pos': pos.astype(np.float32),
                      'q': (R.T @ pos).astype(np.float32),
                      'I': 80.0 * p['lamp_int'] * area_wu,
                      'rgb': rgb.astype(np.float32)})
    return lamps


def _lamp_visibility(dh: np.ndarray, ppu: float, cx: float, cy: float,
                     lamp_q: np.ndarray, p: dict, steps: int = 24) -> np.ndarray:
    """半分辨率:逐像素向灯的 q 位置 march 深度场,返回可见性 [0,1]。
    跳过起点 12%(自身)与终点 10%(灯体),遮挡窗与太阳阴影同一套语义。"""
    h, w = dh.shape
    px0 = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0)
    py0 = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
    qx0 = (px0 - cx) / ppu
    qy0 = (cy - py0) / ppu
    dqx = lamp_q[0] - qx0
    dqy = lamp_q[1] - qy0
    dqz = lamp_q[2] - dh
    blocked = np.zeros((h, w), bool)
    for t in np.linspace(0.12, 0.9, steps, dtype=np.float32):
        qx = qx0 + dqx * t
        qy = qy0 + dqy * t
        qz = dh + dqz * t
        px = qx * ppu + cx
        py = cy - qy * ppu
        inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        xi = np.clip(px, 0, w - 1).astype(np.int32)
        yi = np.clip(py, 0, h - 1).astype(np.int32)
        pen = qz - dh[yi, xi]
        blocked |= inside & (pen > 0.05 + 0.05 * t) & (pen < p['occ_thick'])
    return 1.0 - blocked.astype(np.float32)


def lamp_irradiance(geo: dict, mask: np.ndarray, bg_lin: np.ndarray, p: dict) -> np.ndarray:
    """全部点光源打到几何上的入射光(H,W,3):Σ I·max(N·L̂,0)/(r²+c)·vis。"""
    lamps = extract_lamps(mask, geo, bg_lin, p)
    h, w = geo['depth'].shape
    E = np.zeros((h, w, 3), np.float32)
    if not lamps:
        return E
    P, N = geo['pos'], geo['normal']
    use_vis = p['lamp_vis'] > 0.5
    if use_vis:                                        # 可见性半分辨率算,双线性放回
        hw, hh = max(w // 2, 8), max(h // 2, 8)
        from .geometry import resize_f
        dh = resize_f(geo['depth'], (hw, hh))
        s = hw / w
        ppu_h, cx_h, cy_h = geo['ppu'] * s, geo['cx'] * s, geo['cy'] * s
    for lamp in lamps:
        vec = lamp['pos'][None, None, :] - P
        r2 = np.sum(vec * vec, axis=-1)
        ndl = np.clip(np.sum(N * vec, axis=-1) / np.sqrt(np.maximum(r2, 1e-6)), 0.0, 1.0)
        cutoff = np.exp(-r2 / (p['lamp_range'] * p['lamp_range']))
        contrib = np.minimum(lamp['I'] * ndl / (r2 + p['lamp_falloff']) * cutoff,
                             p['lamp_clamp'])
        if use_vis:
            vis = _lamp_visibility(dh, ppu_h, cx_h, cy_h, lamp['q'], p)
            vis = gaussian_filter(vis, 1.5)          # 半分辨率二值场先软化再放大,去块状边
            contrib = contrib * resize_f(vis, (w, h))
        E += contrib[..., None] * lamp['rgb'][None, None, :]
    return E


def relight(scene: Scene, params: dict | None = None, width: int | None = None) -> np.ndarray:
    """重打光一张场景背景。width=None 用原生分辨率;返回 uint8 (H,W,3) sRGB。"""
    p = merge_params(params)
    nw, nh = scene.native
    if width and width < nw:
        w = int(width)
        h = max(1, round(nh * w / nw))
    else:
        w, h = nw, nh
    px_scale = w / 640.0                            # 模糊类参数的分辨率换算
    bg_srgb = scene.bg_srgb if (w, h) == (nw, nh) else resize_rgb(scene.bg_srgb, (w, h))
    bg_lin = srgb_to_linear(bg_srgb)

    geo = scene.geometry((w, h), normal_sigma=max(0.8, 0.8 * px_scale))

    # ---- 重打光:先除掉白天光,再乘上新光 ----
    # ⚠ 干活的是 sky_field(逐像素半球 march 深度场的天穹可见性)与 screen_shadow
    #   (沿深度场 march 的定向光投影)——除/乘只是最后一步算术。
    #   **被否**(2026-08-20 制作人):S_day/S_new 只用法线朝上项(nup)、不做 march 的写法
    #   ——那是逐像素调色,画不出巷道/屋檐下的遮蔽结构,看着就是贴滤镜。勿回退。
    # 天穹场同时进分子分母:day_hemi==amb_hemi 且无定向光时 ratio≡1(原图不动);
    # 夜间 amb_hemi 拉高 → 巷道/屋檐下/立面按真实遮蔽结构变暗,不是全局压。
    amb_rgb = kelvin_rgb(p['amb_kelvin'])
    if geo is not None:
        # ★ 优先用**烘好的**天穹可见性——运行时消费的就是它。现算的高斯半径随预览宽度变,
        #   与烘焙的固定 512 宽不同,会让工具与游戏差一点点(实测 1.19/255)。用同一张 ⇒
        #   parity 是构造性的。没烘过的场景才回落现算(纯预览场景仍可用)。
        sky = scene.baked_skyvis((w, h))
        if sky is None:
            sky = sky_field(geo, px_scale)
        s_day = (1.0 - p['day_hemi']) + p['day_hemi'] * sky
        s_new = p['amb_int'] * amb_rgb[None, None, :] * \
            ((1.0 - p['amb_hemi']) + p['amb_hemi'] * sky)[..., None]
        if p['sun_int'] > 0:
            L = sun_dir(p['sun_elev'], p['sun_azim'])
            ndl = np.clip(geo['normal'] @ L, 0.0, 1.0)
            shadow = screen_shadow(geo, L, p, px_scale) if p['shadow_strength'] > 0 else 1.0
            sun_rgb = kelvin_rgb(p['sun_kelvin'])
            s_new = s_new + (p['sun_int'] * ndl * shadow)[..., None] * sun_rgb[None, None, :]
        ratio = np.clip(s_new / s_day[..., None], 0.0, p['ratio_max'])
    else:
        ratio = (p['amb_int'] * amb_rgb)[None, None, :]
    out = bg_lin * ratio

    # ---- 发光体(手绘 mask):灯体自亮 + 伪世界点光源照明 + 大气光晕 ----
    if p['emis_gain'] > 0 or p['lamp_int'] > 0:
        mask = scene.emissive_mask((w, h))
        if mask is not None and mask.max() > 0:
            emis_rgb = kelvin_rgb(p['emis_kelvin'])
            src = mask[..., None] * emis_rgb[None, None, :] * p['emis_gain']
            # 灯体自身:压掉重打光结果,用原图纹理调制发光色(灯罩纹理保留)
            out = out * (1.0 - 0.85 * mask[..., None]) + src * (0.25 + 0.75 * bg_lin)
            # 点光源:真照明——N·L/r² 打在周围几何上,沿深度场判遮挡(墙背后没光)
            if p['lamp_int'] > 0 and geo is not None:
                E = lamp_irradiance(geo, mask, bg_lin, p)
                out = out + E * (0.1 + 0.9 * bg_lin)          # 入射光 × albedo
            if p['glow_gain'] > 0:
                r1 = max(p['glow_radius'] * px_scale, 0.1)
                halo = np.stack([gaussian_filter(src[..., c], r1) for c in range(3)], -1)
                out = out + halo * p['glow_gain']             # 大气光晕:加性,不吃 albedo

    # ---- 湿地(雨) ----
    if geo is not None and p['wet'] > 0:
        g = smoothstep(0.55, 0.9, np.clip(geo['normal'][..., 1], 0.0, 1.0))
        out = out * (1.0 - 0.45 * p['wet'] * g[..., None])
        if p['sheen'] > 0:
            out = out + (g * p['sheen'] * 0.12)[..., None] * (amb_rgb * p['amb_int'])[None, None, :]

    # ---- 深度雾 ----
    if p['fog_density'] > 0:
        fog_rgb = kelvin_rgb(p['fog_kelvin']) * p['fog_lum']
        if geo is not None:
            d0, d1 = geo['d_range']
            dn = (geo['depth'] - d0) / max(d1 - d0, 1e-6)
            a = 1.0 - np.exp(-np.maximum(dn - p['fog_start'], 0.0) * p['fog_density'])
            if p['fog_fall'] > 0:
                a = a * np.exp(-np.maximum(geo['pos'][..., 1] - p['fog_y'], 0.0) * p['fog_fall'])
        else:
            a = np.full((h, w), 1.0 - math.exp(-p['fog_density'] * 0.3), np.float32)
        out = out * (1.0 - a[..., None]) + fog_rgb[None, None, :] * a[..., None]

    # ---- 调色 ----
    out = out * (2.0 ** p['ev']) * kelvin_rgb(p['grade_kelvin'])[None, None, :]
    if p['sat'] != 1.0:
        lum = (out @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
        out = lum + (out - lum) * p['sat']
    if p['contrast'] != 1.0:
        out = 0.18 * np.power(np.maximum(out, 0.0) / 0.18, p['contrast'])
    if p['lift'] > 0:
        lum = out @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        out = out + (p['lift'] * 0.08 * np.exp(-lum / 0.06))[..., None] * \
            kelvin_rgb(p['lift_kelvin'])[None, None, :]

    res = linear_to_srgb(np.maximum(out, 0.0))
    if p['keep_src'] > 0:
        res = res * (1.0 - p['keep_src']) + bg_srgb * p['keep_src']
    return np.round(np.clip(res, 0.0, 1.0) * 255.0).astype(np.uint8)


def rig_from_time(t: float) -> dict:
    """一天中任意时刻 → 光照参数补丁(连续、确定)。t∈[0,24)。

    只是给滑杆一个物理合理的起点,美术随后微调;不追求天文精确。
    日出 06:00,日落 19:00;夜间定向光槽切成月光。
    """
    t = t % 24.0
    if 6.0 <= t <= 19.0:
        u = (t - 6.0) / 13.0                       # 0..1 日内进度
        day = math.sin(math.pi * u)                # 0..1 太阳高度因子
        dusk = 1.0 - min(day / 0.35, 1.0)          # 晨昏权重
        return {
            'amb_int': 0.45 + 0.55 * day,
            'amb_kelvin': 6500.0 + 1500.0 * dusk,
            'sun_int': 0.25 + 0.85 * day,
            'sun_elev': 8.0 + 60.0 * day,
            'sun_azim': 110.0 + 140.0 * u,
            'sun_kelvin': 5400.0 - 2800.0 * dusk,
            'ev': -0.15 * dusk,
            'grade_kelvin': 6500.0 - 900.0 * dusk,
        }
    # 夜:20:00 最深,向两端(日落后/日出前)缓升
    if t > 19.0:
        nd = min((t - 19.0) / 1.5, 1.0)
    else:
        nd = min((6.0 - t) / 1.5, 1.0)
    # 纯夜基(与预设「夜」同一定标口径):中性、去饱和、中调压六成、黑位不抬
    return {
        'amb_int': 1.0,
        'amb_hemi': 0.35 + 0.2 * nd,
        'sun_int': 0.15 * (1.0 - nd),
        'ev': -0.15 - 2.13 * nd,
        'contrast': 1.0 - 0.22 * nd,
        'sat': 1.0 + 0.3 * nd,
        'grade_kelvin': 6500.0 + 1000.0 * nd,
        'fog_density': 0.35 * nd, 'fog_start': 0.3, 'fog_lum': 0.10,
    }
