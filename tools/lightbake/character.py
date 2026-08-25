"""立绘(角色 sprite)预览着色 —— `UnifiedCharacterShader` 的 CPU 镜像。

对照源(逐式,不许意译;两边打架以运行时为准):

- `src/rendering/lighting/UnifiedCharacterShader.ts` fragment main:
    法线解码 `n = normalize(−(ne.r·2−1), −(ne.g·2−1), −max(ne.b,0.05))`
    (mirror 只翻 x;flatten 向 (0,0,−1) mix 后再归一);
    q = 脚点 + **屏幕 Δy/(cosT·ppu)** 沿世界 up(R[1,:])上抬 − ne.a·bulge
    (二审 P0-1:此前少除 cosT,θ=32° 的场景整个矮 15%);
    天穹/AO/GI 逐像素三线性(ucSkyAt)—— **AO 与 GI 逐角点 max(a0+a1·N,0)
    后再插值**,只有天穹通道是系数插值后再求值(二审 P1-2:次序反了会让
    背光侧 GI 被邻角正值抵消);太阳与灯 = 与场景**同一份**打包、同一批
    lc*、角色口径 march(灯 16 步 / 太阳 48 步,thick 窗);
    `if (color.a < 0.03) discard` 同阈;形体 AO(contact/form);
    显示走预览统一链(from_hdr·2^ev,与 compose_final 同)。
- `src/rendering/lighting/shadeCore3.glsl`:
    sc3CharBase:`alb = srgb→linear(直通图集) / max((1+N.y)/2·refIntensity,1e-4)`;
    sc3SkyIrradiance / sc3AmbientTerm(入参 ao **不设上界**,1.2 天花板在
    环境项里)/ sc3Shade(base·(skyE+directE+gi));角色侧
    V(N) = clip(t₀/cap₀),cap₀ = max((1+N.y)/2, 1/255)。
- 图集 α 口径(二审 P0-2 验尸):浏览器对**彩色图集**在解码期预乘
  (AssetManager 默认路径),shader 里 `/max(a,1e-4)` 是**还原**直通值;
  PIL 读到的本来就是直通 α ⇒ 这里**不再除 α**。双线性采样 GPU 在
  **预乘域**做 ⇒ 彩色缩放先乘 α、缩后除回;法线图集运行时走
  premultiplied-alpha 模式保原字节 ⇒ 直通缩放。全程 float(PIL 'F')。
- 尺寸:高 = worldHeight、宽 = **worldWidth**(SpriteEntity 两轴独立系数,
  二审 P1-1:用格子长宽比 player 会宽 8.65%);`scale_mul` 对应运行时的
  depthScaleFactor(预览不知深度缩放曲线,给旋钮)。
- charGi 缺省跟随场景 gi;flatten 0 / bulge 0.22;charRefIntensity 来自
  场景 lighting.charRefIntensity。

已知与运行时的**残余差**(有意保留,二审登记):
- 体数据吃 ctx['volume'] 浮点原值,绕过 8-bit 载荷的对数量化与 ±2a0 截断
  (uGiScale/uGiLogSpan 那条路)—— 预览比真机"更准"一档,P7 接线后若要
  逐位对账需补编解码回环;
- 无雾项(场景侧 compose_final 同样无雾,两侧对称;fog.sigma>0 的场景
  预览整体与真机差一层雾);
- 无 depthScaleFactor 曲线(scale_mul 手动)。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .encode import from_hdr, linear_to_srgb, srgb_to_linear
from .lights import (SUN_SHADOW_STRENGTH, _char_lamp_visibility_batch,
                     _char_sun_visibility_batch, _directional_e, _norm_kind,
                     _one_lamp_e, _rest_lights, direction_from_angles,
                     sun_light_of)
from .const import (DEFAULT_SHADOW_BIAS_WU, DEFAULT_SHADOW_THICKNESS_WU)
from .sky import sh_basis, sky_irradiance_sh

ANIM_ROOT = (Path(__file__).resolve().parents[2] / 'public' / 'resources'
             / 'runtime' / 'animation')

__all__ = ['list_characters', 'load_character', 'shade_character']


@dataclass
class CharSprite:
    name: str
    frame: int
    rgba: np.ndarray        # (h,w,4) float32 0..1,单帧,直通 α
    nrm: np.ndarray         # (h,w,4) float32 0..1,与 color 逐 texel 对齐
    world_h_wu: float       # anim.json worldHeight(玩家 = 150,尺度锚)
    world_w_wu: float       # anim.json worldWidth(两轴独立,非格子长宽比)
    states: dict


def list_characters() -> list[str]:
    """可用立绘:animation/ 下同时有 atlas.png + atlas.normal.png + anim.json
    的目录(法线图集是硬依赖 —— 没有它法线退化,不配进预览)。"""
    out = []
    if not ANIM_ROOT.is_dir():
        return out
    for d in sorted(ANIM_ROOT.iterdir()):
        if (d / 'atlas.png').is_file() and (d / 'atlas.normal.png').is_file() \
                and (d / 'anim.json').is_file():
            out.append(d.name)
    return out


def state_first_frame(states: dict, state: str) -> int | None:
    v = states.get(state)
    frames = (v.get('frames') if isinstance(v, dict) else v) \
        if v is not None else None
    return int(frames[0]) if frames else None


def load_character(name: str, frame: int | None = None) -> CharSprite:
    """装一帧立绘(缺省 = idle 首帧;无 idle 取第 0 帧)。"""
    d = ANIM_ROOT / name
    a = json.loads((d / 'anim.json').read_text(encoding='utf-8'))
    cols, rows = int(a['cols']), int(a['rows'])
    cw, ch = int(a['cellWidth']), int(a['cellHeight'])
    states = a.get('states') or {}
    if frame is None:
        frame = state_first_frame(states, 'idle') or 0
    col, row = frame % cols, frame // cols
    if row >= rows:
        raise ValueError(f'{name}: 帧 {frame} 超出网格 {cols}x{rows}')

    def cut(p: Path) -> np.ndarray:
        img = np.asarray(Image.open(p).convert('RGBA'), np.float32) / 255.0
        return img[row * ch:(row + 1) * ch, col * cw:(col + 1) * cw]

    world_h = float(a.get('worldHeight') or 150.0)
    world_w = float(a.get('worldWidth') or (world_h * cw / ch))
    return CharSprite(name=name, frame=frame,
                      rgba=cut(d / 'atlas.png'),
                      nrm=cut(d / 'atlas.normal.png'),
                      world_h_wu=world_h, world_w_wu=world_w,
                      states=states)


def _resize_channel(ch2d: np.ndarray, w: int, h: int) -> np.ndarray:
    return np.asarray(Image.fromarray(np.ascontiguousarray(ch2d, np.float32),
                                      'F').resize((w, h), Image.BILINEAR),
                      np.float32)


def _resize_rgba(img: np.ndarray, w: int, h: int,
                 premultiplied: bool) -> np.ndarray:
    """双线性缩放,α 口径按运行时采样域(二审 P0-2):
    - `premultiplied=True`(彩色图集):GPU 解码期预乘 ⇒ 双线性在**预乘域**
      做,缩后除回直通 —— 否则透明邻域的 RGB 会渗进轮廓;
    - `premultiplied=False`(法线图集,premultiplied-alpha 模式保原字节):
      直通逐通道缩放。⚠ 不许整张 RGBA 交给 PIL:PIL≥12 对 RGBA resize
      自作主张预乘 α,法线图集(α=bulge 高度,常为 0)整张被抹零。
    全程 float('F' 模式),无 uint8 往返。"""
    a = _resize_channel(img[..., 3], w, h)
    if premultiplied:
        rgb = np.stack([_resize_channel(img[..., i] * img[..., 3], w, h)
                        for i in range(3)], -1)
        rgb = rgb / np.maximum(a[..., None], 1e-4)
    else:
        rgb = np.stack([_resize_channel(img[..., i], w, h)
                        for i in range(3)], -1)
    return np.dstack([np.clip(rgb, 0.0, 1.0), a])


def _grid_corners(vol: dict, P: np.ndarray):
    """体网格三线性的角点索引与权重(布局与 check._trilinear 同:
    flat = (ix·ny + iy)·nz + iz,C-order (nx,ny,nz))。"""
    g, bnd = vol['grid'], vol['bounds']
    nx, ny_, nz = int(g['nx']), int(g['ny']), int(g['nz'])
    lo = np.array([bnd['x0'], bnd['y0'], bnd['z0']], np.float64)
    hi = np.array([bnd['x1'], bnd['y1'], bnd['z1']], np.float64)
    t = np.clip((P - lo) / np.maximum(hi - lo, 1e-9), 0.0, 1.0) \
        * (np.array([nx, ny_, nz]) - 1)
    i0 = np.clip(np.floor(t).astype(np.int64), 0,
                 np.array([nx - 1, ny_ - 1, nz - 1]))
    fr = (t - i0).astype(np.float32)
    i1 = np.minimum(i0 + 1, np.array([nx - 1, ny_ - 1, nz - 1]))
    corners, weights = [], []
    for dx in (0, 1):
        wx = (1 - fr[:, 0]) if dx == 0 else fr[:, 0]
        ix = i0[:, 0] if dx == 0 else i1[:, 0]
        for dy in (0, 1):
            wy = (1 - fr[:, 1]) if dy == 0 else fr[:, 1]
            iy = i0[:, 1] if dy == 0 else i1[:, 1]
            for dz in (0, 1):
                wz = (1 - fr[:, 2]) if dz == 0 else fr[:, 2]
                iz = i0[:, 2] if dz == 0 else i1[:, 2]
                corners.append((ix * ny_ + iy) * nz + iz)
                weights.append(wx * wy * wz)
    return corners, weights


def shade_character(ctx: dict, sprite: CharSprite, foot_world,
                    sky_def: dict, sun_dir, gi: float, ev: float,
                    env_rgb, env_gain: float,
                    lights: list[dict] | None = None,
                    char_gi: float | None = None,
                    char_ref_intensity: float = 1.0,
                    flatten: float = 0.0, bulge: float = 0.22,
                    ao_contact: float = 0.0, ao_form: float = 0.0,
                    mirror: bool = False, scale_mul: float = 1.0,
                    notes: list | None = None
                    ) -> tuple[np.ndarray, np.ndarray]:
    """把一帧立绘按运行时角色管线着色,返回 (显示域 sRGB rgb, alpha),
    分辨率 = 该角色在画面上的实际显示大小(world 尺寸·scale_mul → q → ×ppu)。

    E_目标逐像素 = skyE(体天穹×自己法线) + ambientE(体AO) + giE·charGi
                   + sunE + lampE(与场景同一份灯、角色口径 march)
    out = sc3CharBase(图集) · E_目标 → 形体AO → from_hdr·2^ev(预览统一链)。
    `char_gi` None ⇒ 跟随 gi(运行时缺省口径);`scale_mul` 对应运行时的
    depthScaleFactor(透视缩放,预览手动)。α<0.03 的像素按运行时 discard
    口径丢弃(alpha 归零)。"""
    inp = ctx['inp']
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('立绘着色需要体数据(重烘勾「含体积数据」)')
    if char_gi is None:
        char_gi = gi                     # uCharGi = def.charGi ?? def.gi
    spw = float(inp.scene_per_wu)
    qu_h = sprite.world_h_wu * float(scale_mul) / spw    # 角色高(q)
    qu_w = sprite.world_w_wu * float(scale_mul) / spw    # 角色宽(q,独立轴)
    out_h = max(12, int(round(qu_h * inp.ppu)))
    out_w = max(6, int(round(qu_w * inp.ppu)))
    rgba = _resize_rgba(sprite.rgba, out_w, out_h, premultiplied=True)
    nrm = _resize_rgba(sprite.nrm, out_w, out_h, premultiplied=False)
    if mirror:
        rgba = rgba[:, ::-1]
        nrm = nrm[:, ::-1]
    alpha = rgba[..., 3]
    live = alpha >= 0.03                 # 运行时 `if (color.a < 0.03) discard`
    alpha_out = np.where(live, alpha, 0.0).astype(np.float32)
    idx = np.nonzero(live.ravel())[0]
    h, w = out_h, out_w
    rgb_out = np.zeros((h, w, 3), np.float32)
    if idx.size == 0:
        return rgb_out, alpha_out

    # ---- 法线解码(shader 逐字;mirror 只翻方向分量) ----
    ne = nrm.reshape(-1, 4)[idx]
    n = np.stack([-(ne[:, 0] * 2.0 - 1.0), -(ne[:, 1] * 2.0 - 1.0),
                  -np.maximum(ne[:, 2], 0.05)], -1)
    if mirror:
        n[:, 0] = -n[:, 0]
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)
    if flatten > 0.0:
        n = n * (1.0 - flatten) + np.array([0.0, 0.0, -1.0]) * flatten
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)

    # ---- 逐像素 q / P ----
    # 运行时:h_世界 = 屏幕 Δy / (cosT·ppu)(二审 P0-1:少除 cosT 会矮 15%),
    # 竖直方向 = 世界 up 过 R(R[1,:] 即 (0,cosT,−sinT) 的全式);
    # 横向沿 q x̂ 按输出列(锚 = 底边中点,列 w//2 对齐脚点像素)。
    Rm = np.asarray(inp.R, np.float64)
    cos_t = max(float(Rm[1, 1]), 1e-6)
    q_f = np.asarray(foot_world, np.float64) @ Rm
    rr, cc = np.divmod(idx, w)
    hy = (h - 1 - rr).astype(np.float64) / (cos_t * float(inp.ppu))
    up_q = Rm[1, :]
    q_pix = (q_f[None, :] + hy[:, None] * up_q[None, :])
    q_pix[:, 0] += (cc - w // 2) / float(inp.ppu)
    q_pix[:, 2] -= ne[:, 3] * float(bulge)
    P = q_pix @ Rm.T                      # q→世界(R 正交)

    # ---- 体数据逐像素三线性(ucSkyAt 口径,二审 P1-2) ----
    # 天穹:**系数插值后**求值(运行时唯一这么做的通道);
    # AO/GI:**逐角点** max(a0+a1·N,0) 后再按权重插值。
    raw = vol['raw']
    corners, weights = _grid_corners(vol, P)
    sky_c = np.zeros((idx.size, 4), np.float32)
    ao = np.zeros(idx.size, np.float32)
    gi_e = np.zeros((idx.size, 3), np.float32)
    ao_a0, ao_a1 = raw['ao_a0'], raw['ao_a1']
    gi_a0, gi_a1 = raw['gi_a0'], raw['gi_a1']
    sky_a0, sky_a1 = raw['sky_a0'], raw['sky_a1']
    for ci, wi in zip(corners, weights):
        sky_c[:, 0] += wi * sky_a0[ci]
        sky_c[:, 1:] += wi[:, None] * sky_a1[ci]
        ao += wi * np.maximum(ao_a0[ci]
                              + np.einsum('nd,nd->n', ao_a1[ci], n), 0.0)
        gi_e += wi[:, None] * np.maximum(
            gi_a0[ci] + np.einsum('ncd,nd->nc', gi_a1[ci], n), 0.0)
    t0 = np.maximum(sky_c[:, 0]
                    + np.einsum('nd,nd->n', sky_c[:, 1:], n), 0.0)
    cap0 = np.maximum((1.0 + n[:, 1]) * 0.5, 1.0 / 255.0)
    V = np.clip(t0 / cap0, 0.0, 1.0)
    bent = sky_c[:, 1:] + 1e-6
    bent /= np.maximum(np.linalg.norm(bent, axis=-1, keepdims=True), 1e-12)
    wgt = 1.0 - (1.0 - V) ** 2
    nmix = bent * (1.0 - wgt[:, None]) + n * wgt[:, None] + 1e-6
    nmix /= np.maximum(np.linalg.norm(nmix, axis=-1, keepdims=True), 1e-12)
    sh = sky_irradiance_sh(dict(sky_def), sun_dir)
    b = np.asarray(sh_basis(nmix[:, 0].astype(np.float64),
                            nmix[:, 1].astype(np.float64),
                            nmix[:, 2].astype(np.float64)))
    sky_e = np.maximum(b.T @ sh, 0.0) * V[:, None]
    # ⚠ ao 只有下钳(sc3SHTransfer 的 max0);1.2 天花板在环境项里,
    #   入参预先压到 ≤1 会让开阔地那 20% 永远够不到(二审 P2-1)
    amb_e = (np.asarray(env_rgb, np.float32)[None, :] * float(env_gain)
             * np.clip(0.28 + 0.72 * ao, 0.0, 1.2)[:, None])
    gi_e = gi_e * np.float32(char_gi)

    # ---- 太阳 + 灯(与场景同一份数据、同一批 lc*、角色口径 march) ----
    direct_e = np.zeros((idx.size, 3), np.float32)
    lights = lights or []
    qu = 1.0 / spw
    sb = getattr(inp, 'shadow_bias', None) or (DEFAULT_SHADOW_BIAS_WU,
                                               DEFAULT_SHADOW_THICKNESS_WU)
    bias0_q, thick_q = float(sb[0]) * qu, float(sb[1]) * qu
    sun = sun_light_of(lights)
    if sun is not None and float(sun.get('intensity', 0.0)) > 0.0:
        sdir = direction_from_angles(float(sun.get('elevationDeg', 45.0)),
                                     float(sun.get('azimuthDeg', 180.0)))
        strength = SUN_SHADOW_STRENGTH if sun.get('castShadow', True) else 0.0
        sun_vis = 1.0
        if strength > 0.0:
            dq = np.asarray(sdir, np.float64)
            dq /= max(float(np.linalg.norm(dq)), 1e-9)   # 世界向量当 q 方向(照抄)
            blocked = _char_sun_visibility_batch(inp, q_pix, dq,
                                                 bias0_q, thick_q)
            sun_vis = 1.0 - strength * (1.0 - blocked)
        direct_e += _directional_e(sun, n.astype(np.float32), sun_vis)
    for l in _rest_lights(lights, sun, notes):
        kind = _norm_kind(l, notes)
        if kind == 'directional':
            if float(l.get('intensity', 0.0)) > 0.0:
                direct_e += _directional_e(l, n.astype(np.float32), 1.0)
            continue
        vis = 1.0
        if l.get('castShadow', False) and float(l.get('intensity', 0)) > 0:
            lq = (np.asarray(l.get('pos') or [0, 0, 0], np.float64) * qu) @ Rm
            vis = _char_lamp_visibility_batch(inp, q_pix, lq,
                                              bias0_q, thick_q)
        contrib = _one_lamp_e(l, kind, P, n.astype(np.float32), qu, vis,
                              cut_gate=False)
        if contrib is not None:
            direct_e += contrib.reshape(-1, 3)

    # ---- 比例基底 + sc3Shade + 形体 AO + 预览显示链 ----
    # ⚠ 直通图集**不再除 α**(二审 P0-2:运行时 shader 的 /max(a,1e-4) 是
    #   在还原浏览器解码期的预乘;PIL 读到的本来就是直通值,再除 = 边缘
    #   1.8× 亮边 —— player 图集 15.4% 可见像素是部分 α)
    col_rgb = rgba.reshape(-1, 4)[idx]
    alb = srgb_to_linear(col_rgb[:, :3])
    e_ref = np.maximum((1.0 + n[:, 1]) * 0.5 * float(char_ref_intensity),
                       1e-4)
    alb = alb / e_ref[:, None]
    lin = alb * (sky_e + amb_e + direct_e + gi_e)
    vy = rr / max(h - 1, 1)               # vLocal.y:0=头顶,1=脚
    tso = np.clip((vy - 0.78) / 0.22, 0.0, 1.0)
    contact = float(ao_contact) * (tso * tso * (3.0 - 2.0 * tso))
    lin = lin * np.clip(1.0 - contact - float(ao_form) * vy,
                        0.0, 1.0)[:, None]
    out = linear_to_srgb(from_hdr(np.float32(lin)
                                  * np.float32(2.0 ** ev)))
    rgb_out.reshape(-1, 3)[idx] = out
    return rgb_out, alpha_out
