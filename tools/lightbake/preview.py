"""最终渲染预览 —— shadeCore3(§6.1)静态半的 CPU 镜像,**唯一实现**。

GUI 视口、全量可视化页、验收工具都从这里取 —— 预览不存在第二套渲染:

    out = base · (gi·E_bake + E_天光) · 2^ev
    E_天光 = SkySH(mix(Bdir, N, w))·V ,  w = 1 − (1−V)²

无解析灯(太阳/点灯/环境全 0)。base 走运行时同式现算
(`to_hdr(原画)/E_q`,§5.7)。gi=1 + 天光 0 ⇒ 精确回原画(#3 的恒等锚,
本模块的 `identity_check` 提供构造性自证)。
"""
from __future__ import annotations

import math

import numpy as np

from .encode import (LUMA, from_hdr, linear_to_srgb, resize_rgb,
                     srgb_to_linear, to_hdr)
from .gather import bent_of_moments, vis_of_normal
from .sky import sh_basis, sky_irradiance_sh

__all__ = ['TIME_PRESETS', 'base_of_ctx', 'shade_final', 'identity_check']

_SUN_DUSK = [math.sin(math.radians(45)) * math.cos(math.radians(15)),
             math.sin(math.radians(15)),
             math.cos(math.radians(45)) * math.cos(math.radians(15))]

#: 时刻预设:(名字, sky_def, sun_dir | None, 显示 ev 档)。与全量可视化页同一份。
TIME_PRESETS: list[tuple[str, dict, list | None, float]] = [
    ('正午晴天', {'intensity': 1.2, 'profile': 1.0, 'kelvin': 10000},
     None, 0.0),
    ('阴天', {'intensity': 0.7, 'profile': 0.3, 'kelvin': 6800,
              'horizonGain': 0.4, 'horizonSharp': 1.2,
              'horizonKelvin': 6500}, None, 0.0),
    ('黄昏', {'intensity': 0.45, 'profile': 1.0, 'kelvin': 12000,
              'horizonGain': 1.6, 'horizonSharp': 4, 'horizonKelvin': 2600,
              'glowGain': 3.0, 'glowTight': 3, 'glowKelvin': 2100,
              'groundGain': 0.15, 'groundKelvin': 3000}, _SUN_DUSK, 0.5),
    ('夜', {'intensity': 0.035, 'profile': 0.6, 'kelvin': 11000,
            'horizonGain': 0.5, 'horizonSharp': 6, 'horizonKelvin': 8000,
            'groundGain': 0.04, 'groundKelvin': 9000}, None, 2.5),
    ('满月', {'intensity': 0.012, 'profile': 1.0, 'kelvin': 6500},
     None, 3.5),
]


def base_of_ctx(ctx: dict) -> tuple[np.ndarray, np.ndarray]:
    """运行时现算 base 的镜像:`to_hdr(原画)/E_q`(§5.7)。
    返回 (base_rgb, 原画 work 分辨率 sRGB [0,1])。"""
    inp = ctx['inp']
    w, h = inp.work
    bg = (resize_rgb(inp.bg_srgb, (w, h)) if (w, h) != inp.native
          else inp.bg_srgb)
    # 纯除法,无钳位、无上界(§5.7 铁令;对抗审查 P-2:1e-6 地板会在极暗
    # 场景破坏恒等锚)。前提是 log 编解码的 E_q 严格 > 0 —— 注释不算数,
    # 断言算数(复核轮 R-5)。
    e_q = ctx['e_q']
    assert bool((e_q > 0).all()), 'E_q 必须严格 > 0(log 码保证;#7 往返)'
    base = to_hdr(srgb_to_linear(bg)) / e_q
    return base.astype(np.float32), bg


def sky_response(a0f: np.ndarray, a1f: np.ndarray, normal: np.ndarray,
                 sky_def: dict, sun_dir=None) -> np.ndarray:
    """E_天光 = SkySH(mix(Bdir,N,w))·V —— shade 的贵半(SH 基逐像素求值),
    与 gi/ev 无关,GUI 按 preset 缓存它(审查 [6]:174ms/帧全压在这半,
    gi/ev 滑条本不该重付)。"""
    sh_c = sky_irradiance_sh(dict(sky_def), sun_dir)          # (9,3)
    V = vis_of_normal(a0f, a1f, normal)
    wgt = 1.0 - (1.0 - V) ** 2
    nmix = (bent_of_moments(a1f, normal) * (1.0 - wgt[..., None])
            + normal * wgt[..., None])
    # 与 sc3SkyIrradiance 逐字对齐:normalize(mix + 1e-6) —— 加 ε 向量后
    # **真归一**(P-4:max(|·|,1e-6) 不是 normalize,Bdir=−N 的退化处会把
    # SH 求值在原点,与 GLSL 分叉)
    nmix = nmix + np.float32(1e-6)
    nmix = nmix / np.linalg.norm(nmix, axis=-1, keepdims=True)
    h, w = a0f.shape
    b = sh_basis(nmix[..., 0].ravel().astype(np.float64),
                 nmix[..., 1].ravel().astype(np.float64),
                 nmix[..., 2].ravel().astype(np.float64))     # (9, N)
    e_sky = np.maximum(np.asarray(b).T @ sh_c, 0.0).reshape(h, w, 3)
    return (e_sky * V[..., None]).astype(np.float32)


def compose_final(base_rgb: np.ndarray, e_bake: np.ndarray,
                  e_sky: np.ndarray, gi: float = 0.15,
                  ev: float = 0.0, e_env: np.ndarray | None = None,
                  e_lights: np.ndarray | None = None) -> np.ndarray:
    """shade 的便宜半:out = base·(gi·E + E_天光 [+ E_环境 + E_灯])·2^ev →
    显示域。E_环境 = 环境色·强度·clamp(0.28+0.72·AO, 0, 1.2)(§6.1 静态半的
    第三项;见 ambient_env);E_灯 = lights.eval_scene_lights(运行时解析灯
    镜像,§6.1 的 E_太阳+E_灯 两项)。毫秒级。"""
    e_target = np.float32(gi) * e_bake + e_sky
    if e_env is not None:
        e_target = e_target + e_env
    if e_lights is not None:
        e_target = e_target + e_lights
    return linear_to_srgb(from_hdr(base_rgb
                                   * (e_target * np.float32(2.0 ** ev))))


def ambient_env(ao: np.ndarray, ambient_rgb, gain: float) -> np.ndarray:
    """§6.1 的 E_环境 项(AO 的唯一消费处,与运行时同式)。"""
    mod = np.clip(0.28 + 0.72 * np.asarray(ao, np.float32), 0.0, 1.2)
    c = np.asarray(ambient_rgb, np.float32).reshape(1, 1, 3)
    return (c * np.float32(gain) * mod[..., None]).astype(np.float32)


def sample_volume_probe(ctx: dict, pos_world) -> dict:
    """在任意世界点三线性采一份**实体口径**的体数据(天穹矩/AO矩/GI矩)——
    与运行时实体采 char_volume 同一插值、同一表示(§6.1:两侧只差
    G-buffer 怎么填)。"""
    from .check import _trilinear
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('ctx 无体数据(重烘时勾「含体积数据」)')
    raw = vol['raw']
    n = len(raw['sky_a0'])
    M = np.concatenate([raw['sky_a0'][:, None], raw['sky_a1'],
                        raw['ao_a0'][:, None], raw['ao_a1'],
                        raw['gi_a0'], raw['gi_a1'].reshape(n, 9)], 1
                       ).astype(np.float32)
    t = _trilinear(M, vol['bounds'], vol['grid'],
                   np.asarray([pos_world], np.float64))[0]
    return {'sky_a0': float(t[0]), 'sky_a1': t[1:4].astype(np.float32),
            'ao_a0': float(t[4]), 'ao_a1': t[5:8].astype(np.float32),
            'gi_a0': t[8:11].astype(np.float32),
            'gi_a1': t[11:20].reshape(3, 3).astype(np.float32)}


def shade_probe_ball(ctx: dict, center_world, sky_def: dict, sun_dir,
                     gi: float, ev: float, env_rgb, env_gain: float,
                     radius_px: int, radius_q: float, albedo: float = 0.5,
                     occlusion_only: bool = False,
                     lights: list | None = None, components: bool = False):
    """探针球 = 实体着色口径的 §6.1 镜像(角色融入度目视)。

    **逐像素位形**(制作人 2026-08-26 抓的:此前只在球心采一次体 + 逐像素
    法线,灯也拿球心算 —— 贴灯放球看不到球面梯度):球面每个像素的伪世界
    位置 P = center + radius_q·N,进 `sample_entity_volume`(ucSkyAt 唯一
    实现,天穹系数插值/AO·GI 逐角点 max0)与 `eval_entity_lights`(实体
    灯循环唯一实现,与立绘共用)。

        E_目标 = gi·E_GI(P,N) + SkySH(mix(Bdir,N,w))·V + E_环境(AO) + E_灯
        out    = albedo · E_目标 · 2^ev  → 同一显示变换

    `occlusion_only`(§6.3 验收口径):平盘 2·a₀(球心采样)。
    返回 (rgb, alpha);`components=True` 额外返回中间量字典
    (normal/V/vis_up/bent/ao/a0/a1/gi/e_sky/e_lights/qz,全逐像素)。"""
    from .character import sample_entity_volume
    from .lights import eval_entity_lights
    inp = ctx['inp']
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('探针需要体数据(重烘时勾「含体积数据」)')
    R = np.asarray(inp.R, np.float64)
    r = int(max(radius_px, 4))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1].astype(np.float32) / float(r)
    mask = (xx ** 2 + yy ** 2) <= 1.0
    if occlusion_only:
        sample = sample_volume_probe(ctx, center_world)
        val = float(np.clip(2.0 * sample['sky_a0'], 0.0, 1.0))
        rgb = np.full(mask.shape + (3,), val, np.float32)
        return rgb, mask.astype(np.float32)
    nz = np.sqrt(np.maximum(1.0 - xx ** 2 - yy ** 2, 0.0))
    # 屏幕基 → 世界:屏幕右 = R[:,0],屏幕上 = R[:,1](yy 向下为正取负),
    # 朝观者 = −R[:,2](q = w@R 的列即三根轴)
    N = (xx[..., None] * R[:, 0].astype(np.float32)
         + (-yy)[..., None] * R[:, 1].astype(np.float32)
         + nz[..., None] * (-R[:, 2]).astype(np.float32))
    N = (N / np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)
         ).astype(np.float32)
    n_flat = N.reshape(-1, 3)
    # 逐像素伪世界位置:球面点(不是球心!)
    P = (np.asarray(center_world, np.float64)[None, :]
         + np.float64(radius_q) * n_flat.astype(np.float64))
    sky_c, ao_f, gi_f = sample_entity_volume(vol, P, n_flat)
    t0 = np.maximum(sky_c[:, 0]
                    + np.einsum('nd,nd->n', sky_c[:, 1:], n_flat), 0.0)
    cap0 = np.maximum((1.0 + n_flat[:, 1]) * 0.5, 1.0 / 255.0)
    V = np.clip(t0 / cap0, 0.0, 1.0).reshape(mask.shape)
    bent_f = sky_c[:, 1:] + 1e-6
    bent_f = bent_f / np.maximum(
        np.linalg.norm(bent_f, axis=-1, keepdims=True), 1e-12)
    bent = bent_f.reshape(mask.shape + (3,)).astype(np.float32)
    w = 1.0 - (1.0 - V) ** 2
    nmix = bent * (1.0 - w[..., None]) + N * w[..., None]
    nmix = nmix + np.float32(1e-6)
    nmix = nmix / np.linalg.norm(nmix, axis=-1, keepdims=True)
    sh = sky_irradiance_sh(dict(sky_def), sun_dir)
    b = np.asarray(sh_basis(nmix[..., 0].ravel().astype(np.float64),
                            nmix[..., 1].ravel().astype(np.float64),
                            nmix[..., 2].ravel().astype(np.float64)))
    e_sky = (np.maximum(b.T @ sh, 0.0).reshape(mask.shape + (3,))
             * V[..., None]).astype(np.float32)
    e_gi = gi_f.reshape(mask.shape + (3,))
    ao = ao_f.reshape(mask.shape)
    e_env = 0.0
    if env_gain and env_gain > 0:
        mod = np.clip(0.28 + 0.72 * ao, 0.0, 1.2)
        e_env = (np.asarray(env_rgb, np.float32).reshape(1, 1, 3)
                 * np.float32(env_gain) * mod[..., None])
    e_lights = eval_entity_lights(lights or [], P, n_flat, inp
                                  ).reshape(mask.shape + (3,))
    e_t = (np.float32(gi) * e_gi + e_sky + e_env + e_lights) \
        * np.float32(2.0 ** ev)
    rgb = linear_to_srgb(from_hdr(np.float32(albedo) * e_t))
    if not components:
        return rgb, mask.astype(np.float32)
    up = np.broadcast_to(np.array([0, 1, 0], np.float32),
                         n_flat.shape).copy()
    t0_up = np.maximum(sky_c[:, 0]
                       + np.einsum('nd,nd->n', sky_c[:, 1:], up), 0.0)
    vis_up = np.clip(t0_up / np.maximum((1.0 + up[:, 1]) * 0.5, 1.0 / 255.0),
                     0.0, 1.0)
    qz = (P @ R)[:, 2]
    comps = {
        'normal': N.astype(np.float32),
        'V': V.astype(np.float32),
        'vis_up': vis_up.reshape(mask.shape).astype(np.float32),
        'bent': bent,
        'ao': np.clip(ao, 0.0, 1.0).astype(np.float32),
        'a0': sky_c[:, 0].reshape(mask.shape),
        'a1': sky_c[:, 1:].reshape(mask.shape + (3,)),
        'gi': e_gi.astype(np.float32),
        'e_sky': e_sky,
        'e_lights': e_lights.astype(np.float32),
        'qz': qz.reshape(mask.shape).astype(np.float32),
    }
    return rgb, mask.astype(np.float32), comps


def volume_sky_at_surface(ctx: dict) -> tuple[np.ndarray, np.ndarray]:
    """体矩在**表面**三线性重建 (a₀,a₁)(自检 #5 的口径)—— 用它替换逐像素
    矩去着色,就是「角色/实体从体数据受光」的一致性直接可视化。"""
    from .check import _trilinear
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('ctx 无体数据(重烘时勾「含体积数据」)')
    raw = vol['raw']
    M = np.concatenate([raw['sky_a0'][:, None], raw['sky_a1']], 1
                       ).astype(np.float32)
    pts = ctx['inp'].world.reshape(-1, 3).astype(np.float64)
    t = _trilinear(M, vol['bounds'], vol['grid'], pts)
    h, w = ctx['moments_smooth'][0].shape
    return (t[:, 0].reshape(h, w).astype(np.float32),
            t[:, 1:4].reshape(h, w, 3).astype(np.float32))


def volume_ao_at_surface(ctx: dict) -> np.ndarray:
    """体 AO 在**表面**重建(2026-08-26:「AO 重建没走样」的对照通道 ——
    此前 GUI 只有逐像素 AO,没有从体重建的 AO 可看;实测两者走样形态
    与 GI 体完全同型,这是矩体+三线性的固有长相,不是 GI 特有)。"""
    from .character import sample_entity_volume
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('ctx 无体数据(重烘时勾「含体积数据」)')
    inp = ctx['inp']
    h, w = ctx['moments_smooth'][0].shape
    P = inp.world.reshape(-1, 3).astype(np.float64)
    nrm = ctx['normal'].reshape(-1, 3).astype(np.float32)
    _sky, ao, _gi = sample_entity_volume(vol, P, nrm)
    return np.clip(ao, 0.0, 1.0).reshape(h, w)


def volume_gi_at_surface(ctx: dict) -> np.ndarray:
    """体 GI 在**表面**重建 E(制作人 2026-08-27「场景只吃 GI volume」的
    buffer)。采样与实体同一实现(sample_entity_volume:SH-L2 钳位余弦,
    AO/GI 逐角点 max0)。收敛公理:分辨率→∞ 时 → 逐像素 E间接·gain
    (L2 核截断 ~1.6%;L1 有 ~23% 钳位余弦核截断底,见 §15)。"""
    from .character import sample_entity_volume
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('ctx 无体数据(重烘时勾「含体积数据」)')
    inp = ctx['inp']
    h, w = ctx['moments_smooth'][0].shape
    P = inp.world.reshape(-1, 3).astype(np.float64)
    nrm = ctx['normal'].reshape(-1, 3).astype(np.float32)
    _sky, _ao, gi = sample_entity_volume(vol, P, nrm)
    return gi.reshape(h, w, 3)


def shade_final(base_rgb: np.ndarray, e_bake: np.ndarray, a0f: np.ndarray,
                a1f: np.ndarray, normal: np.ndarray, sky_def: dict,
                sun_dir=None, gi: float = 0.15, ev: float = 0.0) -> np.ndarray:
    """§6.1 静态半镜像,返回显示域 sRGB [0,1]。= compose_final(sky_response)。
    V/Bdir/SH 全部走库内唯一实现。"""
    return compose_final(base_rgb, e_bake,
                         sky_response(a0f, a1f, normal, sky_def, sun_dir),
                         gi, ev)


def identity_check(ctx: dict) -> int:
    """构造性恒等锚:gi=1 + 天光 0 ⇒ 应逐字节 ≡ 原画(255 饱和位除外)。
    返回不同字节数(自检 #3 的预览侧对照)。"""
    base, bg = base_of_ctx(ctx)
    a0f, a1f = ctx['moments_smooth']
    img = shade_final(base, ctx['e_q'], a0f, a1f, ctx['inp'].normal,
                      {'intensity': 0.0, 'profile': 1.0}, None, 1.0, 0.0)
    got = np.round(np.clip(img, 0, 1) * 255).astype(np.int16)
    ref = np.round(np.clip(bg, 0, 1) * 255).astype(np.int16)
    # #3 同口径豁免:**只**豁免「ref==255 且 got==254」的 Reinhard 强制位
    # (复核轮 R-4:ref>=254 整位豁免会把 254 位上的真实失配也藏掉)
    diff = got != ref
    sat = (ref == 255) & (got == 254)
    return int((diff & ~sat).sum())
