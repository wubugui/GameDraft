"""运行时解析灯(平行/点/聚/面)的 CPU 镜像 —— **逐式对照,不许意译**。

对照源(单一真相在运行时,这里只是镜像;两边打架以运行时为准):

- `src/rendering/lighting/lightingCore.glsl`
    lcFalloff / lcPointLight / lcSpotLight / lcRectIrradiance / lcAreaLight /
    lcDirectionalLight / lcMarchVisibility(角色侧阴影用)
- `src/rendering/lighting/lightPacking.ts`
    packLights(wu→q 折算 / dir??orientation 取值序 / C.y 按 kind 复用 /
    缺省锥角 25°/40° / flags 位 / MAX_STATIC_LIGHTS=24 截断)、
    sunLightOf(第一盏 enabled directional = 日/月,castShadow??true ⇒ 0.9)、
    directionFromAngles(z = **+cos·cos**,翻号会前后颠倒)、packShadowBias
- `src/rendering/lighting/SceneLightingPass.ts`
    场景侧:sunVis = 1 − strength·(1−sc3DirectVisibility(ω))(线性重建,
    不 march);灯阴影 = shadowPrefix 判据「∃k: z(k)−d(k) > bias」(prefix
    是该判据的**精确解**,thick 不参与);`usable = cast && !directional &&
    i < LIGHTS_PER_SLAB·2 = 8` —— **第 9 盏起强制不投影**;额外 directional
    vis≡1;强度 0 / cut<1e-4 逐像素早退(lcAreaLight 同阈)
- `src/rendering/lighting/UnifiedCharacterShader.ts`
    角色侧:同一批 lc*;灯阴影 = ucLightVisibility(16 步 march、len·0.92、
    bias0+0.02·st·i、thick 窗);**太阳也 march**:lcMarchVisibility(q,
    normalize(uSunDir), steps=uShadow.z=48, len=uShadow.y=3.5),再
    sunVis = 1 − 0.9·(1−blocked)。⚠ 运行时把**世界系**的 uSunDir 直接当
    q 方向 march(没有过 R)—— 这是运行时的既定行为,镜像逐字照抄,不"修"。

单位纪律(packLights 头注):作者面一切长度都是 **wu**;求值一切发生在
**q 空间**,折算 `quPerWu = 1/scene_per_wu` 只在入口做一次。
色温→RGB 走 `sky.resolve_light_color`(kelvin.ts 的既有镜像,golden 锁死)。

已知与运行时的**残余差**(有意保留,审查记录 2026-08-26):
- 场景侧阴影按径向 1px 自适应步进逼近 prefix 判据(上限 768 步);运行时
  prefix 是零步进精确解,且跑在 native 深度上,这里是 work 深度最近邻 ——
  细杆类遮挡体有亚像素级差异。
- 未知 kind 回落成点光(镜像 `LIGHT_KIND_CODE[l.kind] ?? 0`)并往 notes 出声。

⚠ 本模块只算 E_灯(辐照,§6.1 的加法项),**不含**灯体自发光/大气光晕
(那是运行时显示层的事,不参与 E_目标)。
"""
from __future__ import annotations

import math

import numpy as np

from .const import (DEFAULT_LAMP_RADIUS_WU, DEFAULT_LIGHT_RANGE_WU,
                    DEFAULT_SHADOW_BIAS_WU, DEFAULT_SHADOW_THICKNESS_WU)
from .sky import resolve_light_color

__all__ = ['LIGHT_KINDS', 'sun_light_of', 'direction_from_angles',
           'eval_scene_lights', 'eval_probe_lights',
           'default_light', 'retype_light']

LIGHT_KINDS = ('point', 'spot', 'area', 'directional')

#: SceneLightingPass:sun.castShadow ⇒ uShadow.x = 0.9,否则 0
SUN_SHADOW_STRENGTH = 0.9
#: 角色侧太阳 march(uShadow.y / uShadow.z,packLights 常量 [0.9, 3.5, 48, 2])
SUN_MARCH_LEN_Q = 3.5
SUN_MARCH_STEPS = 48
#: 场景/角色共用的 cut 早退阈(lcAreaLight 内建同值;pass 把它提到 march 前)
_CUT_EPS = 1e-4
#: lightPacking.MAX_STATIC_LIGHTS —— 超出的盏数运行时静默丢弃(打包处告警)
MAX_STATIC_LIGHTS = 24
#: shadowPrefix.LIGHTS_PER_SLAB·2 —— 场景侧线扫只有两张 slab,第 9 盏起不投影
SHADOW_SLAB_LIGHTS = 8
#: 场景侧阴影密集采样:目标径向 1px 步进,夹在 [64, 768];
#: 直接调 `_scene_lamp_visibility` 时的缺省(库内 eval 走自适应)。
SCENE_SHADOW_STEPS = 192
_SHADOW_STEPS_MIN, _SHADOW_STEPS_MAX = 64, 768


def default_light(index: int, kind: str = 'point') -> dict:
    """一盏新灯的缺省值(编辑面,`lightDefaults.makeLight` 逐字口径:长度
    一律 **wu**;makeLight 对**所有非 directional** 都写 softeningRadius
    (面光那份是惰性字段,求值不吃 —— `retype` 换型时才删),面光另带
    rollDeg=0。复核 2026-08-26 纠正:此前少了这两处。"""
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
                    rollDeg=0.0, twoSided=False)
    elif kind == 'directional':
        for k in ('pos', 'range', 'softeningRadius'):
            base.pop(k, None)
        base.update(elevationDeg=45.0, azimuthDeg=180.0,
                    intensity=0.4, kelvin=7000.0)
    return base


def retype_light(l: dict, kind: str) -> dict:
    """换 kind 的字段卫生(lightDefaults.retype 口径):共有字段随人走,
    旧 kind 专属字段清掉,新 kind 专属字段补缺省;**softeningRadius 只随进
    点/聚**(面光不吃软化 —— 留着会静默失效,作者以为自己调了)。
    list 字段拷一层,不共享引用。"""
    out = default_light(0, kind)
    if kind not in ('point', 'spot'):
        out.pop('softeningRadius', None)   # retype 口径:面光删软化(惰性字段)
    out['id'] = l.get('id', out['id'])
    for k in ('enabled', 'intensity', 'kelvin', 'castShadow'):
        if k in l:
            out[k] = l[k]
    if 'color' in l:
        out['color'] = list(l['color'])
    if kind != 'directional':
        if 'pos' in l:
            out['pos'] = list(l['pos'])
        if 'range' in l:
            out['range'] = l['range']
    if kind in ('point', 'spot') and 'softeningRadius' in l:
        out['softeningRadius'] = l['softeningRadius']
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
    """GLSL smoothstep 逐字:t = clamp((x−e0)/(e1−e0), 0, 1)。
    e0>e1(outer<inner 的病态填法)时 GLSL 未定义、实测给反向斜坡 ——
    这里同样**不掩盖**(审查 P1-6:此前 max(…,1e-9) 把它变成硬阶跃,
    与 GPU 行为分叉);只有 e0==e1 才退化成阶跃。"""
    denom = e1 - e0
    if denom == 0.0:
        t = (np.asarray(x) >= e1).astype(np.float32)
    else:
        t = np.clip((x - e0) / denom, 0.0, 1.0)
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

def _scene_lamp_visibility(inp, q_flat: np.ndarray, lq: np.ndarray,
                           bias_q: float,
                           steps: int = SCENE_SHADOW_STEPS) -> np.ndarray:
    """场景侧灯阴影判据(shadowPrefix 的连续式,密集采样逼近):

        被挡 ⟺ ∃ 段上采样点: z(t) − d(t) > bias

    thick 刻意不参与(shadowPrefix.ts 实测带不带 thick 逐位相同 ——
    那条路上没有这个参数)。q_flat: (n,3) 被照像素的 q。
    投影沿段是**仿射的**(q 的 x/y 与像素线性对应),预折成
    px(t) = px₀ + t·Δpx,循环里只剩 FMA + 取整 + 采样。"""
    h, w = inp.depth.shape
    ppu = np.float32(inp.ppu)
    px0 = (np.float32(inp.cx) + q_flat[:, 0].astype(np.float32) * ppu)
    py0 = (np.float32(inp.cy) - q_flat[:, 1].astype(np.float32) * ppu)
    z0 = q_flat[:, 2].astype(np.float32)
    px1 = np.float32(inp.cx + float(lq[0]) * inp.ppu)
    py1 = np.float32(inp.cy - float(lq[1]) * inp.ppu)
    z1 = np.float32(lq[2])
    dpx, dpy, dz = px1 - px0, py1 - py0, z1 - z0
    occ = np.zeros(q_flat.shape[0], bool)
    depth = inp.depth
    bias = np.float32(bias_q)
    for i in range(1, steps):
        t = np.float32(i / steps)
        px = px0 + dpx * t
        py = py0 + dpy * t
        inside = (px >= 0) & (px <= w - 1) & (py >= 0) & (py <= h - 1)
        xi = np.clip(np.rint(px).astype(np.int32), 0, w - 1)
        yi = np.clip(np.rint(py).astype(np.int32), 0, h - 1)
        pen = (z0 + dz * t) - depth[yi, xi]
        occ |= inside & (pen > bias)
    return (~occ).astype(np.float32)


def _lc_march_visibility(inp, q0: np.ndarray, dir_q: np.ndarray, steps: int,
                         march_len: float, bias0_q: float,
                         thick_q: float) -> float:
    """lcMarchVisibility 逐字(角色侧通用):固定步数、bias 随步增、
    **thick 窗**(pen 超窗 = 墙背后的空气,不算挡)。标量。"""
    h, w = inp.depth.shape
    st = march_len / max(steps, 1)
    for i in range(1, steps + 1):
        qm = q0 + dir_q * (st * i)
        px = inp.cx + float(qm[0]) * inp.ppu
        py = inp.cy - float(qm[1]) * inp.ppu
        if not (0 <= px <= w - 1 and 0 <= py <= h - 1):
            continue
        d = float(inp.depth[int(round(py)), int(round(px))])
        pen = float(qm[2]) - d
        bias = bias0_q + 0.02 * st * i
        if bias < pen < thick_q:
            return 0.0
    return 1.0


def _char_lamp_visibility(inp, q0: np.ndarray, lq: np.ndarray,
                          bias0_q: float, thick_q: float) -> float:
    """角色侧灯阴影 = ucLightVisibility 逐字:朝灯 16 步、len·0.92。"""
    d_vec = lq - q0
    ln = float(np.linalg.norm(d_vec))
    if ln < 1e-5:
        return 1.0
    return _lc_march_visibility(inp, q0, d_vec / ln, 16, ln * 0.92,
                                bias0_q, thick_q)


def _char_lamp_visibility_batch(inp, q_pix: np.ndarray, lq: np.ndarray,
                                bias0_q: float, thick_q: float) -> np.ndarray:
    """`ucLightVisibility` 的逐像素批量版(立绘着色:每个 sprite 像素的 q
    不同,各自朝灯 march)。语义与标量版逐字同:16 步、len·0.92、
    bias0+0.02·st·i、thick 窗、len<1e-5 ⇒ 1。q_pix: (n,3)。"""
    h, w = inp.depth.shape
    d = lq[None, :] - q_pix
    ln = np.linalg.norm(d, axis=-1)
    act = ln >= 1e-5
    dirn = d / np.maximum(ln, 1e-12)[:, None]
    st = ln * 0.92 / 16.0
    occ = np.zeros(q_pix.shape[0], bool)
    depth = inp.depth
    for i in range(1, 17):
        qm = q_pix + dirn * (st * i)[:, None]
        px = inp.cx + qm[:, 0] * inp.ppu
        py = inp.cy - qm[:, 1] * inp.ppu
        inside = (px >= 0) & (px <= w - 1) & (py >= 0) & (py <= h - 1)
        xi = np.clip(np.rint(px).astype(np.int32), 0, w - 1)
        yi = np.clip(np.rint(py).astype(np.int32), 0, h - 1)
        pen = qm[:, 2] - depth[yi, xi]
        bias = bias0_q + 0.02 * st * i
        occ |= inside & (pen > bias) & (pen < thick_q)
    return np.where(act, (~occ).astype(np.float32), np.float32(1.0))


def _char_sun_visibility_batch(inp, q_pix: np.ndarray,
                               dir_q: np.ndarray, bias0_q: float,
                               thick_q: float) -> np.ndarray:
    """角色侧太阳 march 的逐像素批量版(48 步、len 3.5、方向恒定 ——
    运行时把世界系 uSunDir 直接当 q 方向,照抄)。返回 blocked∈{0,1}。"""
    h, w = inp.depth.shape
    st = SUN_MARCH_LEN_Q / SUN_MARCH_STEPS
    occ = np.zeros(q_pix.shape[0], bool)
    depth = inp.depth
    for i in range(1, SUN_MARCH_STEPS + 1):
        qm = q_pix + dir_q[None, :] * (st * i)
        px = inp.cx + qm[:, 0] * inp.ppu
        py = inp.cy - qm[:, 1] * inp.ppu
        inside = (px >= 0) & (px <= w - 1) & (py >= 0) & (py <= h - 1)
        xi = np.clip(np.rint(px).astype(np.int32), 0, w - 1)
        yi = np.clip(np.rint(py).astype(np.int32), 0, h - 1)
        pen = qm[:, 2] - depth[yi, xi]
        bias = bias0_q + 0.02 * st * i
        occ |= inside & (pen > bias) & (pen < thick_q)
    return (~occ).astype(np.float32)


# ------------------------------------------------ 单盏灯的 E(N 任意形状)

def _one_lamp_e(l: dict, kind: str, P: np.ndarray, N: np.ndarray, qu: float,
                vis, cut_gate: bool = True) -> np.ndarray | None:
    """一盏非 directional 灯在 P/N 上的 E。vis 由调用方给(场景侧逐像素图 /
    角色侧标量)。`cut_gate`:场景 pass 的逐像素 cut<1e-4 早退 —— 角色侧
    没有这条(UnifiedCharacterShader 的灯循环无 pass 级早退),探针传 False;
    面光的 cut<1e-4 → 0 在 lcAreaLight **内部**,两侧都有,恒生效。
    返回 None = 全零(强度 0,两侧都恒等于零,跳过是纯优化)。"""
    inten = float(l.get('intensity', 0.0))
    if inten <= 0.0:
        return None
    col = resolve_light_color(l.get('color'), l.get('kelvin')).astype(np.float32)
    pos = np.asarray(l.get('pos') or [0.0, 0.0, 0.0], np.float64) * qu
    rng = float(l.get('range', DEFAULT_LIGHT_RANGE_WU)) * qu
    soft_r = float(l.get('softeningRadius', DEFAULT_LAMP_RADIUS_WU)) * qu
    softening = soft_r * soft_r
    v = pos[None, :] - P.reshape(-1, 3)
    r2 = np.einsum('nd,nd->n', v, v)
    cut = np.exp(-r2 / max(rng * rng, 1e-6))
    n_flat = N.reshape(-1, 3)
    vis_flat = (np.full(r2.shape, float(vis), np.float32)
                if np.isscalar(vis) or np.asarray(vis).ndim == 0
                else np.asarray(vis, np.float32).reshape(-1))
    if kind == 'spot':
        L = v * (1.0 / np.sqrt(np.maximum(r2, 1e-12)))[:, None]
        sd = np.asarray(l.get('dir') or l.get('orientation') or [0, 0, -1],
                        np.float64)
        sd = sd / max(np.linalg.norm(sd), 1e-9)
        cos_in = math.cos(math.radians(float(l.get('innerAngleDeg', 25.0))))
        cos_out = math.cos(math.radians(float(l.get('outerAngleDeg', 40.0))))
        cone = _smoothstep(cos_out, cos_in, np.einsum('nd,d->n', -L, sd))
        ndl = np.maximum(np.einsum('nd,nd->n', n_flat, L), 0.0)
        e = inten * ndl * cone * _falloff(r2, rng, softening) * vis_flat
        if cut_gate:
            e = np.where(cut >= _CUT_EPS, e, 0.0)
    elif kind == 'area':
        # ⚠ 取值序与 packLights 逐字:**dir ?? orientation ?? [0,0,−1]**
        #   (审查 P0-1:反过来会照亮相反的一面)
        n_ = np.asarray(l.get('dir') or l.get('orientation') or [0, 0, -1],
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
        e = np.where(cut >= _CUT_EPS, e, 0.0)      # lcAreaLight 内建,恒生效
    else:                                          # point;未知 kind 由调用方
        L = v * (1.0 / np.sqrt(np.maximum(r2, 1e-12)))[:, None]  # 归一成 point
        ndl = np.maximum(np.einsum('nd,nd->n', n_flat, L), 0.0)
        e = inten * ndl * _falloff(r2, rng, softening) * vis_flat
        if cut_gate:
            e = np.where(cut >= _CUT_EPS, e, 0.0)
    e = e.astype(np.float32)
    return e.reshape(N.shape[:-1])[..., None] * col[None, :]


def _directional_e(l: dict, N: np.ndarray, vis) -> np.ndarray:
    """lcDirectionalLight:color·intensity·max(N·L,0)·vis。"""
    col = resolve_light_color(l.get('color'), l.get('kelvin')).astype(np.float32)
    d = direction_from_angles(float(l.get('elevationDeg', 45.0)),
                              float(l.get('azimuthDeg', 180.0)))
    ndl = np.maximum(N @ d.astype(N.dtype), 0.0)
    return (float(l.get('intensity', 0.0)) * ndl * vis)[..., None] * col


def _norm_kind(l: dict, notes: list | None) -> str:
    """kind 归一:未知值回落成 point(镜像 `LIGHT_KIND_CODE[l.kind] ?? 0`,
    运行时就这么渲染),并往 notes 出声 —— 静默跟着错比崩溃好,但必须响。"""
    kind = l.get('kind')
    if kind in LIGHT_KINDS:
        return kind
    if notes is not None:
        notes.append(f"灯 {l.get('id', '?')}: 未知 kind {kind!r},按 point "
                     '渲染(运行时同回落)')
    return 'point'


def _rest_lights(lights: list[dict], sun, notes: list | None) -> list[dict]:
    """packLights 的过滤序:enabled 且非太阳,**超 24 盏丢弃**(运行时同样
    丢,打包处告警 —— 静默截断会让美术以为灯没生效)。"""
    rest = [l for l in lights
            if l.get('enabled', True) and l is not sun]
    if len(rest) > MAX_STATIC_LIGHTS:
        if notes is not None:
            notes.append(f'灯超上限:{len(rest)} > {MAX_STATIC_LIGHTS},'
                         f'丢弃后 {len(rest) - MAX_STATIC_LIGHTS} 盏'
                         '(运行时同样丢)')
        rest = rest[:MAX_STATIC_LIGHTS]
    return rest


# ------------------------------------------------ 场景侧(SceneLightingPass 镜像)

def eval_scene_lights(lights: list[dict], inp, a0f: np.ndarray,
                      a1f: np.ndarray, normal: np.ndarray,
                      vis_cache: dict | None = None,
                      notes: list | None = None) -> np.ndarray:
    """场景逐像素 E_太阳 + E_灯(SceneLightingPass 静态半的镜像)。

    - 太阳(第一盏 enabled directional):遮蔽走**线性重建**
      `1 − strength·(1−V_dir(ω))`,不 march(运行时原话:换太阳方向不用重烘)
    - 点/聚/面:castShadow 且**打包下标 < 8** ⇒ shadowPrefix 判据
      (线扫只有两张 slab,第 9 盏起运行时强制不投影 —— 镜像同缩);
      march 只跑 cut≥1e-4 的活像素,径向 1px 自适应步进(夹 [64,768])
    - 额外 directional:vis≡1(pass 逐字);超 24 盏丢弃

    输入 wu,内部一次折算 q(quPerWu = 1/scene_per_wu)。返回 (h,w,3) 线性
    辐照,与 E_天光/E_环境同单位,直接加进 §6.1 的 E_目标。
    `vis_cache`:逐灯阴影图缓存,键含 (灯位, range, bias) —— 阴影 march 的
    活像素域随 range 走,所以 range 必须进键;调强度/色温不重 march。
    `notes`:list,运行时会告警/静默降级的事往里出声(丢弃、slab 缩水、
    未知 kind)。"""
    h, w = a0f.shape
    e = np.zeros((h, w, 3), np.float32)
    if not lights:
        return e
    from .gather import vis_of_dir
    qu = 1.0 / float(inp.scene_per_wu)
    sb = getattr(inp, 'shadow_bias', None) or (DEFAULT_SHADOW_BIAS_WU,
                                               DEFAULT_SHADOW_THICKNESS_WU)
    bias_q = float(sb[0]) * qu
    sun = sun_light_of(lights)
    if sun is not None and float(sun.get('intensity', 0.0)) > 0.0:
        sdir = direction_from_angles(float(sun.get('elevationDeg', 45.0)),
                                     float(sun.get('azimuthDeg', 180.0)))
        strength = SUN_SHADOW_STRENGTH if sun.get('castShadow', True) else 0.0
        # V_dir 闭式走库内唯一表达(gather.vis_of_dir 明令不许各抄一遍)
        vdir = vis_of_dir(a0f, a1f, sdir)
        e += _directional_e(sun, normal, 1.0 - strength * (1.0 - vdir))
    P = inp.world.astype(np.float64)
    world_flat = inp.world.reshape(-1, 3).astype(np.float64)
    for i, l in enumerate(_rest_lights(lights, sun, notes)):
        kind = _norm_kind(l, notes)
        if kind == 'directional':
            if float(l.get('intensity', 0.0)) > 0.0:
                e += _directional_e(l, normal, 1.0)
            continue
        vis: object = 1.0
        cast = l.get('castShadow', False) and float(l.get('intensity', 0)) > 0
        if cast and i >= SHADOW_SLAB_LIGHTS:
            if notes is not None:
                notes.append(f"灯 {l.get('id', '?')}: 打包下标 {i} ≥ "
                             f'{SHADOW_SLAB_LIGHTS},运行时线扫不覆盖,'
                             '阴影强制关(镜像同缩)')
            cast = False
        if cast:
            pos = np.asarray(l.get('pos') or [0, 0, 0], np.float64)
            rng_q = float(l.get('range', DEFAULT_LIGHT_RANGE_WU)) * qu
            ck = (tuple(np.round(pos, 4)), round(rng_q, 6), round(bias_q, 9))
            if vis_cache is not None and ck in vis_cache:
                vis = vis_cache[ck]
            else:
                # 世界→q:R 正交,qᵀ = wᵀR(与 Pass 的 toQ 同式)
                lq = (pos * qu) @ np.asarray(inp.R, np.float64)
                dl = pos * qu - world_flat
                live = (np.exp(-np.einsum('nd,nd->n', dl, dl)
                               / max(rng_q * rng_q, 1e-6)) >= _CUT_EPS)
                vis_full = np.ones(h * w, np.float32)
                if live.any():
                    q_sub = inp.q.reshape(-1, 3)[live]
                    # 径向 1px 步进:步数 = 段的最大图像长度(px),夹 [64,768]
                    dpx = (float(inp.cx) + float(lq[0]) * inp.ppu) \
                        - (inp.cx + q_sub[:, 0] * inp.ppu)
                    dpy = (float(inp.cy) - float(lq[1]) * inp.ppu) \
                        - (inp.cy - q_sub[:, 1] * inp.ppu)
                    steps = int(np.clip(
                        math.ceil(float(np.hypot(dpx, dpy).max())),
                        _SHADOW_STEPS_MIN, _SHADOW_STEPS_MAX))
                    vis_full[live] = _scene_lamp_visibility(
                        inp, q_sub.astype(np.float64), lq, bias_q, steps)
                vis = vis_full.reshape(h, w)
                if vis_cache is not None:
                    vis_cache[ck] = vis
        contrib = _one_lamp_e(l, kind, P, normal, qu, vis, cut_gate=True)
        if contrib is not None:
            e += contrib.reshape(h, w, 3)
    return e


# ------------------------------------------------ 角色侧(UnifiedCharacterShader 镜像)

def eval_entity_lights(lights: list[dict], P: np.ndarray, N: np.ndarray,
                       inp, notes: list | None = None) -> np.ndarray:
    """实体(立绘/探针)**逐像素**解析灯 —— UnifiedCharacterShader 灯循环
    的唯一实现(character 与 probe 共用,别各抄一遍):

    - 太阳:逐像素 march(48 步/len 3.5,方向 = 世界 ω **不过 R**,照抄)
    - 点/聚/面:castShadow ⇒ 逐像素 ucLightVisibility 批量 march
    - 无 pass 级 cut 早退(角色循环没有);>24 盏截断同一份打包

    P/N: (n,3) 世界(q 尺度)与法线。返回 (n,3) 线性辐照。"""
    e = np.zeros(P.shape, np.float32)
    if not lights:
        return e
    qu = 1.0 / float(inp.scene_per_wu)
    sb = getattr(inp, 'shadow_bias', None) or (DEFAULT_SHADOW_BIAS_WU,
                                               DEFAULT_SHADOW_THICKNESS_WU)
    bias0_q, thick_q = float(sb[0]) * qu, float(sb[1]) * qu
    Rm = np.asarray(inp.R, np.float64)
    q_pix = np.asarray(P, np.float64) @ Rm
    sun = sun_light_of(lights)
    if sun is not None and float(sun.get('intensity', 0.0)) > 0.0:
        sdir = direction_from_angles(float(sun.get('elevationDeg', 45.0)),
                                     float(sun.get('azimuthDeg', 180.0)))
        strength = SUN_SHADOW_STRENGTH if sun.get('castShadow', True) else 0.0
        sun_vis: object = 1.0
        if strength > 0.0:
            dq = np.asarray(sdir, np.float64)
            dq /= max(float(np.linalg.norm(dq)), 1e-9)
            blocked = _char_sun_visibility_batch(inp, q_pix, dq,
                                                 bias0_q, thick_q)
            sun_vis = 1.0 - strength * (1.0 - blocked)
        e += _directional_e(sun, np.asarray(N, np.float32), sun_vis)
    for l in _rest_lights(lights, sun, notes):
        kind = _norm_kind(l, notes)
        if kind == 'directional':
            if float(l.get('intensity', 0.0)) > 0.0:
                e += _directional_e(l, np.asarray(N, np.float32), 1.0)
            continue
        vis: object = 1.0
        if l.get('castShadow', False) and float(l.get('intensity', 0)) > 0:
            lq = (np.asarray(l.get('pos') or [0, 0, 0], np.float64) * qu) @ Rm
            vis = _char_lamp_visibility_batch(inp, q_pix, lq,
                                              bias0_q, thick_q)
        contrib = _one_lamp_e(l, kind, np.asarray(P, np.float64),
                              np.asarray(N, np.float32), qu, vis,
                              cut_gate=False)
        if contrib is not None:
            e += contrib.reshape(-1, 3)
    return e


def eval_probe_lights(lights: list[dict], N: np.ndarray, center_world,
                      inp, notes: list | None = None) -> np.ndarray:
    """探针球(实体口径)的 E_太阳 + E_灯 —— UnifiedCharacterShader 镜像:

    - 同一批 lc* 公式,P = 探针中心(角色一个点位受光,N 逐球面像素);
      **无 pass 级 cut 早退**(角色循环没有那两条,cut_gate=False)
    - 太阳:**march**(lcMarchVisibility,48 步 / len 3.5 / 同 bias/thick 窗;
      方向 = normalize(世界 uSunDir) 直接当 q 方向 —— 运行时既定行为,照抄),
      再 sunVis = 1 − 0.9·(1−blocked);castShadow??true ⇒ strength 0.9
    - 灯阴影:castShadow ⇒ ucLightVisibility 逐字(16 步、len·0.92),从
      探针中心 march 一次(标量 vis);**没有 slab-8 缩水**(角色 march 不走
      线扫),但 24 盏截断同样生效(同一份打包)

    N: (h,w,3) 球面法线;center_world: 探针中心(q 尺度世界坐标)。
    单点位形的薄包装 —— 逐像素位形走 `eval_entity_lights`(唯一实现)。"""
    n_flat = np.asarray(N, np.float32).reshape(-1, 3)
    P = np.broadcast_to(np.asarray(center_world, np.float64),
                        n_flat.shape).copy()
    return eval_entity_lights(lights, P, n_flat, inp,
                              notes=notes).reshape(N.shape)
