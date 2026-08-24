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
                  ev: float = 0.0) -> np.ndarray:
    """shade 的便宜半:out = base·(gi·E + E_天光)·2^ev → 显示域。毫秒级。"""
    e_target = (np.float32(gi) * e_bake + e_sky) * np.float32(2.0 ** ev)
    return linear_to_srgb(from_hdr(base_rgb * e_target))


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
