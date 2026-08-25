"""运行时解析灯(平行/点/聚/面)的 CPU 镜像 —— **逐式对照,不许意译**。

对照源(单一真相在运行时,这里只是镜像;两边打架以运行时为准):

- `src/rendering/lighting/lightingCore.glsl`
    lcFalloff / lcPointLight / lcSpotLight / lcRectIrradiance / lcAreaLight /
    lcDirectionalLight / lcMarchVisibility(角色侧灯阴影用)
- `src/rendering/lighting/lightPacking.ts`
    packLights(wu→q 折算 / C.y 按 kind 复用 / 缺省锥角 25°/40° / flags 位)、
    sunLightOf(第一盏 enabled directional = 日/月,castShadow ⇒ strength 0.9)、
    directionFromAngles(z = **+cos·cos**,翻号会前后颠倒)、packShadowBias
- `src/rendering/lighting/SceneLightingPass.ts`
    场景侧:sunVis = 1 − strength·(1−sc3DirectVisibility(ω))(线性重建,不
    march);灯阴影 = shadowPrefix 判据「∃k: z(k)−d(k) > bias」(prefix 是该
    判据的**精确解**,thick 不参与 —— shadowPrefix.ts 实测逐位相同);额外
    directional 灯 vis≡1;cut<1e-4 整像素早退(与 lcAreaLight 同一阈)
- `src/rendering/lighting/UnifiedCharacterShader.ts`
    角色侧:同一批 lc*;灯阴影 = ucLightVisibility(16 步 march、len·0.92、
    bias0+0.02·st·i、thick 窗)

单位纪律(packLights 头注):作者面一切长度都是 **wu**;求值一切发生在
**q 空间**,折算 `quPerWu = 1/scene_per_wu` 只在入口做一次。
色温→RGB 走 `sky.resolve_light_color`(kelvin.ts 的既有镜像,golden 锁死)。

⚠ 本模块只算 E_灯(辐照,§6.1 的加法项),**不含**灯体自发光/大气光晕
(那是运行时显示层的事,不参与 E_目标)。
"""
from __future__ import annotations

import math

import numpy as np

from .const import (DEFAULT_LAMP_RADIUS_WU, DEFAULT_LIGHT_RANGE_WU,
                    DEFAULT_SHADOW_BIAS_WU, DEFAULT_SHADOW_THICKNESS_WU)
from .gather import vdir_coeffs
from .sky import resolve_light_color

__all__ = ['LIGHT_KINDS', 'sun_light_of', 'direction_from_angles',
           'eval_scene_lights', 'eval_probe_lights',
           'default_light', 'retype_light']

LIGHT_KINDS = ('point', 'spot', 'area', 'directional')

#: SceneLightingPass:sun.castShadow ⇒ uShadow.x = 0.9,否则 0
SUN_SHADOW_STRENGTH = 0.9
#: 场景侧 cut 早退阈(lcAreaLight 内建同值;pass 把它提到 march 前)
_CUT_EPS = 1e-4
#: 场景侧阴影判据的离散步数。运行时 prefix 是连续判据的精确解(零步进);
#: CPU 镜像用密集采样逼近 —— shadowPrefix.ts 实测 128 定步长与真值差
#: 0.15%–0.71%,192 步只会更近。
SCENE_SHADOW_STEPS = 192


def default_light(index: int, kind: str = 'point') -> dict:
    """一盏新灯的缺省值 —— `tools/editor/editors/scene_lights.default_light`
    同口径(那边在 Qt 环境外不可 import,这里镜像;两边由缺省常量共同锚定:
    作用半径 3 个人高、发光体半径 1/15 个人高)。长度一律 **wu**。"""
    base: dict = {'id': f'light_{index}', 'kind': kind, 'pos': [0.0, 0.0, 0.0],
                  'kelvin': 2400.0, 'intensity': 2.5,
                  'range': float(DEFAULT_LIGHT_RANGE_WU),
                  'softeningRadius': float(DEFAULT_LAMP_RADIUS_WU),
                  'castShadow': False, 'enabled': True}
    if kind == 'spot':
        base.update(dir=[0.0, -1.0, 0.3], innerAngleDeg=25.0,
                    outerAngleDeg=45.0)
    elif kind == 'area':
        base.update(size=[135.0, 90.0], orientation=[0.0, 0.0, -1.0],
                    twoSided=False)
    elif kind == 'directional':
        for k in ('pos', 'range', 'softeningRadius'):
            base.pop(k, None)
        base.update(elevationDeg=45.0, azimuthDeg=180.0,
                    intensity=0.4, kelvin=7000.0)
    return base


def retype_light(l: dict, kind: str) -> dict:
    """换 kind 的字段卫生(lightDefaults.retype 同旨):共有字段随人走,
    旧 kind 专属字段清掉,新 kind 专属字段补缺省 —— 脏字段留在 JSON 里会被
    运行时校验挑出来(scene_lights 的 rollDeg-只对面光 那类检查)。"""
    out = default_light(0, kind)
    out['id'] = l.get('id', out['id'])
    for k in ('enabled', 'intensity', 'kelvin', 'color', 'castShadow'):
        if k in l:
            out[k] = l[k]
    if kind != 'directional':
        for k in ('pos', 'range', 'softeningRadius'):
            if k in l:
                out[k] = l[k]
    return out


def sun_light_of(lights: list[dict]) -> dict | None:
    """「哪一盏是太阳」的唯一定义:第一盏 enabled 的 directional
    (lightPacking.sunLightOf 逐字)。"""
    for l in lights or []:
        if l.get('kind') == 'directional' and l.get('enabled', True):
            return l
    return None


def direction_from_angles(elevation_deg: float, azimuth_deg: float
                          ) -> np.ndarray:
    """仰角/方位角 → 世界方向(lightPacking.directionFromAngles 逐字:
    z 是 **+cos·cos**,az 0 = 画面深处、90 = 右侧)。"""
    e = math.radians(elevation_deg)
    a = math.radians(azimuth_deg)
    return np.array([math.cos(e) * math.sin(a), math.sin(e),
                     math.cos(e) * math.cos(a)], np.float32)


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _falloff(r2: np.ndarray, rng: float, softening: float) -> np.ndarray:
    """lcFalloff:物理 1/r² + 有限作用半径的高斯截断。"""
    cut = np.exp(-r2 / max(rng * rng, 1e-6))
    return cut / (r2 + softening)


def _area_axes(n: np.ndarray, roll: float) -> tuple[np.ndarray, np.ndarray]:
    """areaAxes 逐字:up 选轴 → 参考基 → 绕 n 的平面内 roll。返回单位轴
    (调用方自己乘半宽/半高)。"""
    up = (np.array([1.0, 0.0, 0.0]) if abs(float(n[1])) > 0.95
          else np.array([0.0, 1.0, 0.0]))
    u = np.cross(up, n)
    u = u / max(np.linalg.norm(u), 1e-9)
    v = np.cross(n, u)
    c, s = math.cos(roll), math.sin(roll)
    return (u * c + v * s).astype(np.float32), (v * c - u * s).astype(np.float32)


def _rect_irradiance(P: np.ndarray, N: np.ndarray,
                     verts: list[np.ndarray]) -> np.ndarray:
    """lcRectIrradiance(Lambert 1760 多边形辐照度,带符号)逐字,向量化。
    P/N: (...,3);verts: 4×(3,)。"""
    p = [v[None, :] - P.reshape(-1, 3) for v in verts]          # 4×(n,3)
    p = [x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-12)
         for x in p]
    n_flat = N.reshape(-1, 3)
    total = np.zeros(p[0].shape[0], np.float64)
    for i in range(4):
        a, b = p[i], p[(i + 1) % 4]
        ax = np.cross(a, b)
        ln = np.linalg.norm(ax, axis=-1)
        ok = ln > 1e-6
        ang = np.arccos(np.clip(np.einsum('nd,nd->n', a, b), -1.0, 1.0))
        contrib = ang * np.einsum('nd,nd->n', ax, n_flat) / np.maximum(ln, 1e-12)
        total += np.where(ok, contrib, 0.0)
    return (total * (0.5 / math.pi)).reshape(P.shape[:-1]).astype(np.float32)


# ------------------------------------------------ 阴影可见度(两侧两套,都照抄)

def _project_depth(inp, qs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """q 点 → work 像素 → 深度场采样(最近邻)。返回 (深度, 在幅内掩码)。
    像素映射与 input.load 的 q 构造互逆:px = cx + x·ppu,py = cy − y·ppu。"""
    h, w = inp.depth.shape
    px = inp.cx + qs[..., 0] * inp.ppu
    py = inp.cy - qs[..., 1] * inp.ppu
    inside = (px >= 0) & (px <= w - 1) & (py >= 0) & (py <= h - 1)
    xi = np.clip(np.round(px).astype(np.int64), 0, w - 1)
    yi = np.clip(np.round(py).astype(np.int64), 0, h - 1)
    return inp.depth[yi, xi], inside


def _scene_lamp_visibility(inp, q_flat: np.ndarray, lq: np.ndarray,
                           bias_q: float,
                           steps: int = SCENE_SHADOW_STEPS) -> np.ndarray:
    """场景侧灯阴影判据(shadowPrefix 的连续式,密集采样逼近):

        被挡 ⟺ ∃ 段上采样点: z(t) − d(t) > bias

    thick 刻意不参与 —— shadowPrefix.ts 实测六盏灯带不带 thick **逐位相同**
    (prefix 那条路上根本没有这个参数)。q_flat: (n,3) 被照像素的 q。"""
    occ = np.zeros(q_flat.shape[0], bool)
    seg = lq[None, :] - q_flat
    for i in range(1, steps):
        t = i / steps
        qs = q_flat + seg * t
        d, inside = _project_depth(inp, qs)
        pen = qs[:, 2] - d
        occ |= inside & (pen > bias_q)
    return (~occ).astype(np.float32)


def _char_lamp_visibility(inp, q0: np.ndarray, lq: np.ndarray,
                          bias0_q: float, thick_q: float) -> float:
    """角色侧灯阴影 = ucLightVisibility → lcMarchVisibility 逐字:
    16 步、marchLen = len·0.92、bias = bias0 + 0.02·st·i、thick 窗。标量。"""
    d_vec = lq - q0
    ln = float(np.linalg.norm(d_vec))
    if ln < 1e-5:
        return 1.0
    dir_q = d_vec / ln
    steps, march_len = 16, ln * 0.92
    st = march_len / steps
    for i in range(1, steps + 1):
        qm = q0 + dir_q * (st * i)
        d, inside = _project_depth(inp, qm[None, :])
        if not bool(inside[0]):
            continue
        pen = float(qm[2]) - float(d[0])
        bias = bias0_q + 0.02 * st * i
        if bias < pen < thick_q:
            return 0.0
    return 1.0


# ------------------------------------------------ 单盏灯的 E(N 任意形状)

def _one_lamp_e(l: dict, P: np.ndarray, N: np.ndarray, qu: float,
                vis) -> np.ndarray | None:
    """一盏非 directional 灯在 P/N 上的 E(不含 vis 的来源 —— 调用方给,
    场景侧是逐像素图、角色侧是标量)。返回 None = 全零(早退)。"""
    inten = float(l.get('intensity', 0.0))
    if inten <= 0.0:                       # pass 早退①:零乘任何数都是零
        return None
    kind = l.get('kind')
    col = resolve_light_color(l.get('color'), l.get('kelvin')).astype(np.float32)
    pos = np.asarray(l.get('pos') or [0.0, 0.0, 0.0], np.float64) * qu
    rng = float(l.get('range', DEFAULT_LIGHT_RANGE_WU)) * qu
    soft_r = float(l.get('softeningRadius', DEFAULT_LAMP_RADIUS_WU)) * qu
    softening = soft_r * soft_r
    v = pos[None, :] - P.reshape(-1, 3)
    r2 = np.einsum('nd,nd->n', v, v)
    cut = np.exp(-r2 / max(rng * rng, 1e-6))
    live = cut >= _CUT_EPS                 # pass 早退②(lcAreaLight 同阈)
    if not live.any():
        return None
    n_flat = N.reshape(-1, 3)
    vis_flat = (np.full(r2.shape, float(vis), np.float32)
                if np.isscalar(vis) or np.asarray(vis).ndim == 0
                else np.asarray(vis, np.float32).reshape(-1))
    if kind == 'point':
        L = v * (1.0 / np.sqrt(np.maximum(r2, 1e-12)))[:, None]
        ndl = np.maximum(np.einsum('nd,nd->n', n_flat, L), 0.0)
        e = inten * ndl * _falloff(r2, rng, softening) * vis_flat
    elif kind == 'spot':
        L = v * (1.0 / np.sqrt(np.maximum(r2, 1e-12)))[:, None]
        sd = np.asarray(l.get('dir') or l.get('orientation') or [0, 0, -1],
                        np.float64)
        sd = sd / max(np.linalg.norm(sd), 1e-9)
        cos_in = math.cos(math.radians(float(l.get('innerAngleDeg', 25.0))))
        cos_out = math.cos(math.radians(float(l.get('outerAngleDeg', 40.0))))
        cone = _smoothstep(cos_out, cos_in, np.einsum('nd,d->n', -L, sd))
        ndl = np.maximum(np.einsum('nd,nd->n', n_flat, L), 0.0)
        e = inten * ndl * cone * _falloff(r2, rng, softening) * vis_flat
    elif kind == 'area':
        n_ = np.asarray(l.get('orientation') or l.get('dir') or [0, 0, -1],
                        np.float64)
        n_ = n_ / max(np.linalg.norm(n_), 1e-9)
        roll = math.radians(float(l.get('rollDeg', 0.0)))
        size = l.get('size') or [DEFAULT_LIGHT_RANGE_WU * 0.3,
                                 DEFAULT_LIGHT_RANGE_WU * 0.2]
        au, av = _area_axes(n_, roll)
        hu = au.astype(np.float64) * (float(size[0]) * 0.5 * qu)
        hv = av.astype(np.float64) * (float(size[1]) * 0.5 * qu)
        # lcAreaLight:单面判据在矩形法线上(cross(halfU,halfV)),
        # 顶点按「从正面看是逆时针」绕(运行时有整段实测验尸,不许换)
        d = pos[None, :] - P.reshape(-1, 3)
        e_rect = _rect_irradiance(P.reshape(-1, 3), n_flat,
                                  [pos - hu - hv, pos - hu + hv,
                                   pos + hu + hv, pos + hu - hv])
        if bool(l.get('twoSided', False)):
            e_rect = np.abs(e_rect)
        else:
            face_n = np.cross(hu, hv)
            face_n = face_n / max(np.linalg.norm(face_n), 1e-12)
            front = np.einsum('d,nd->n', face_n, -d) > 0.0
            e_rect = np.where(front, np.maximum(e_rect, 0.0), 0.0)
        e = inten * e_rect * cut * vis_flat
    else:
        raise ValueError(f'未知灯 kind: {kind!r}')
    e = np.where(live, e, 0.0).astype(np.float32)
    return e.reshape(N.shape[:-1])[..., None] * col[None, :] \
        if N.ndim > 2 else e[..., None] * col[None, :]


def _directional_e(l: dict, N: np.ndarray, vis) -> np.ndarray:
    """lcDirectionalLight:color·intensity·max(N·L,0)·vis。"""
    col = resolve_light_color(l.get('color'), l.get('kelvin')).astype(np.float32)
    d = direction_from_angles(float(l.get('elevationDeg', 45.0)),
                              float(l.get('azimuthDeg', 180.0)))
    ndl = np.maximum(N @ d.astype(N.dtype), 0.0)
    return (float(l.get('intensity', 0.0)) * ndl * vis)[..., None] * col


# ------------------------------------------------ 场景侧(SceneLightingPass 镜像)

def eval_scene_lights(lights: list[dict], inp, a0f: np.ndarray,
                      a1f: np.ndarray, normal: np.ndarray,
                      shadow_steps: int = SCENE_SHADOW_STEPS,
                      vis_cache: dict | None = None) -> np.ndarray:
    """场景逐像素 E_太阳 + E_灯(SceneLightingPass 静态半的镜像)。

    - 太阳(第一盏 enabled directional):遮蔽走**线性重建**
      `1 − strength·(1−V_dir(ω))`,不 march(运行时原话:换太阳方向不用重烘)
    - 点/聚/面:castShadow ⇒ shadowPrefix 判据;否则 vis=1
    - 额外 directional:vis≡1(pass 逐字)

    输入 wu,内部一次折算 q(quPerWu = 1/scene_per_wu)。返回 (h,w,3) 线性
    辐照,与 E_天光/E_环境同单位,直接加进 §6.1 的 E_目标。
    `vis_cache`:可选逐灯阴影图缓存(键 = 灯位/bias/步数)—— 阴影只依赖
    几何与灯位,调强度/色温不必重 march(GUI 实时编辑靠它)。"""
    h, w = a0f.shape
    e = np.zeros((h, w, 3), np.float32)
    if not lights:
        return e
    qu = 1.0 / float(inp.scene_per_wu)
    sb = getattr(inp, 'shadow_bias', None) or (DEFAULT_SHADOW_BIAS_WU,
                                               DEFAULT_SHADOW_THICKNESS_WU)
    bias_q = float(sb[0]) * qu
    sun = sun_light_of(lights)
    if sun is not None and float(sun.get('intensity', 0.0)) > 0.0:
        sdir = direction_from_angles(float(sun.get('elevationDeg', 45.0)),
                                     float(sun.get('azimuthDeg', 180.0)))
        strength = SUN_SHADOW_STRENGTH if sun.get('castShadow', True) else 0.0
        alpha, beta = vdir_coeffs(a0f, a1f)
        vdir = np.clip(alpha + beta @ sdir, 0.0, 1.0)
        sun_vis = 1.0 - strength * (1.0 - vdir)
        col = resolve_light_color(sun.get('color'), sun.get('kelvin'))
        ndl = np.maximum(normal @ sdir, 0.0)
        e += (float(sun['intensity']) * ndl * sun_vis)[..., None] \
            * col.astype(np.float32)[None, None, :]
    P = inp.world.astype(np.float64)
    for l in lights:
        if not l.get('enabled', True) or l is sun:
            continue
        if l.get('kind') == 'directional':
            if float(l.get('intensity', 0.0)) > 0.0:
                e += _directional_e(l, normal, 1.0)
            continue
        vis: object = 1.0
        if l.get('castShadow', False) and float(l.get('intensity', 0)) > 0:
            pos = np.asarray(l.get('pos') or [0, 0, 0], np.float64)
            ck = (tuple(np.round(pos, 4)), round(bias_q, 9), shadow_steps)
            if vis_cache is not None and ck in vis_cache:
                vis = vis_cache[ck]
            else:
                lq = (pos * qu) @ np.asarray(inp.R, np.float64)  # 世界→q:R 正交,qᵀ=wᵀR
                vis = _scene_lamp_visibility(
                    inp, inp.q.reshape(-1, 3).astype(np.float64), lq, bias_q,
                    shadow_steps).reshape(h, w)
                if vis_cache is not None:
                    vis_cache[ck] = vis
        contrib = _one_lamp_e(l, P, normal, qu, vis)
        if contrib is not None:
            e += contrib.reshape(h, w, 3)
    return e


# ------------------------------------------------ 角色侧(UnifiedCharacterShader 镜像)

def eval_probe_lights(lights: list[dict], N: np.ndarray, center_world,
                      inp, sky_a0: float, sky_a1: np.ndarray) -> np.ndarray:
    """探针球(实体口径)的 E_太阳 + E_灯 —— UnifiedCharacterShader 镜像:

    - 同一批 lc* 公式,P = 探针中心(角色一个点位受光,N 逐球面像素)
    - 太阳遮蔽:`1 − strength·(1−V_dir(ω))`,V_dir 用**体采样**的 (a₀,a₁)
      闭式系数(实体的遮蔽来源就是 char_volume,§6.1)
    - 灯阴影:castShadow ⇒ ucLightVisibility 逐字(16 步 march、len·0.92、
      bias0+0.02·st·i、thick 窗),从探针中心 march 一次(标量 vis)

    N: (h,w,3) 球面法线;center_world: 探针中心(q 尺度世界坐标)。"""
    e = np.zeros(N.shape, np.float32)
    if not lights:
        return e
    qu = 1.0 / float(inp.scene_per_wu)
    sb = getattr(inp, 'shadow_bias', None) or (DEFAULT_SHADOW_BIAS_WU,
                                               DEFAULT_SHADOW_THICKNESS_WU)
    bias0_q, thick_q = float(sb[0]) * qu, float(sb[1]) * qu
    Rm = np.asarray(inp.R, np.float64)
    center = np.asarray(center_world, np.float64)
    q0 = center @ Rm                       # 世界→q(R 正交,转置即逆)
    sun = sun_light_of(lights)
    if sun is not None and float(sun.get('intensity', 0.0)) > 0.0:
        sdir = direction_from_angles(float(sun.get('elevationDeg', 45.0)),
                                     float(sun.get('azimuthDeg', 180.0)))
        strength = SUN_SHADOW_STRENGTH if sun.get('castShadow', True) else 0.0
        a0s = np.asarray([sky_a0], np.float32)
        a1s = np.asarray(sky_a1, np.float32).reshape(1, 3)
        alpha, beta = vdir_coeffs(a0s, a1s)
        vdir = float(np.clip(alpha[0] + beta[0] @ sdir, 0.0, 1.0))
        e += _directional_e(sun, N, 1.0 - strength * (1.0 - vdir))
    P = np.broadcast_to(center.astype(np.float64), N.shape)
    for l in lights:
        if not l.get('enabled', True) or l is sun:
            continue
        if l.get('kind') == 'directional':
            if float(l.get('intensity', 0.0)) > 0.0:
                e += _directional_e(l, N, 1.0)
            continue
        vis = 1.0
        if l.get('castShadow', False) and float(l.get('intensity', 0)) > 0:
            lq = (np.asarray(l.get('pos') or [0, 0, 0], np.float64) * qu) @ Rm
            vis = _char_lamp_visibility(inp, q0, lq, bias0_q, thick_q)
        contrib = _one_lamp_e(l, P, N, qu, vis)
        if contrib is not None:
            e += contrib.reshape(N.shape)
    return e
