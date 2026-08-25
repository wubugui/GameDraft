"""立绘(角色 sprite)预览着色 —— `UnifiedCharacterShader` 的 CPU 镜像。

对照源(逐式,不许意译;两边打架以运行时为准):

- `src/rendering/lighting/UnifiedCharacterShader.ts` fragment main:
    法线解码 `n = normalize(−(ne.r·2−1), −(ne.g·2−1), −max(ne.b,0.05))`
    (mirror 只翻 x;flatten 向 (0,0,−1) mix 后再归一);
    q = 脚点 + 高度沿**竖直方向**上抬 − ne.a·bulge(运行时是
    (0, h·cosT, −h·sinT) —— 即世界 up 在 q 里的方向 R[1,:] 的无 roll 特例,
    这里用 R[1,:] 全式);天穹/AO/GI 逐像素三线性(ucSkyAt,按**角色自己的
    法线**求值);太阳与灯 = 与场景**同一份**打包、同一批 lc*、角色口径
    march(灯 16 步 / 太阳 48 步,thick 窗);形体 AO(contact/form);
    显示变换走预览统一链(from_hdr·2^ev,与 compose_final 同)。
- `src/rendering/lighting/shadeCore3.glsl`:
    sc3CharBase:`alb = srgb→linear(图集/α) / max((1+N.y)/2·refIntensity,1e-4)`
    (「基底不是 albedo」—— 比例式提出来的中间因子);
    sc3SkyIrradiance / sc3AmbientTerm / sc3Shade(base·(skyE+ambE+directE+gi));
    角色侧 V(N) = clamp(t₀/cap₀, 0, 1),t₀ = max(a₀+a₁·N, 0),
    cap₀ = max((1+N.y)/2, 1/255) —— 与 gather.vis_of_normal 同口径。
- charGi 缺省**跟随场景 gi**(不是恒 1;运行时注释:两个旋钮各管一边是坑);
  flatten 缺省 0、bulge 缺省 0.22(characterShape);
  charRefIntensity 来自场景 lighting.charRefIntensity。

图集来源:`public/resources/runtime/animation/<name>/`(atlas.png +
atlas.normal.png + anim.json 的 cols/rows/cellWidth/cellHeight/worldHeight/
states)。烘焙侧 GI 直接吃 ctx['volume'] 的浮点原值,无对数编解码
(uGiScale/uGiLogSpan 是 8-bit 载荷那条路的事)。
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
    rgba: np.ndarray        # (h,w,4) float32 0..1,单帧
    nrm: np.ndarray         # (h,w,4) float32 0..1,与 color 逐 texel 对齐
    world_h_wu: float       # anim.json worldHeight(玩家 = 150,尺度锚)
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


def load_character(name: str, frame: int | None = None) -> CharSprite:
    """装一帧立绘(缺省 = idle 首帧;无 idle 取第 0 帧)。"""
    d = ANIM_ROOT / name
    a = json.loads((d / 'anim.json').read_text(encoding='utf-8'))
    cols, rows = int(a['cols']), int(a['rows'])
    cw, ch = int(a['cellWidth']), int(a['cellHeight'])
    states = a.get('states') or {}
    if frame is None:
        idle = states.get('idle')
        frames = (idle.get('frames') if isinstance(idle, dict) else idle) \
            if idle is not None else None
        frame = int(frames[0]) if frames else 0
    col, row = frame % cols, frame // cols
    if row >= rows:
        raise ValueError(f'{name}: 帧 {frame} 超出网格 {cols}x{rows}')

    def cut(p: Path) -> np.ndarray:
        img = np.asarray(Image.open(p).convert('RGBA'), np.float32) / 255.0
        return img[row * ch:(row + 1) * ch, col * cw:(col + 1) * cw]

    return CharSprite(name=name, frame=frame,
                      rgba=cut(d / 'atlas.png'),
                      nrm=cut(d / 'atlas.normal.png'),
                      world_h_wu=float(a.get('worldHeight') or 150.0),
                      states=states)


def _resize_rgba(img: np.ndarray, w: int, h: int) -> np.ndarray:
    """直通(非预乘)双线性缩放 —— 与 GPU 采样口径一致。
    ⚠ 不许整张按 RGBA 交给 PIL:PIL ≥12 对 RGBA resize **预乘 α**,
    α=0 的纹素 RGB 被抹零 —— 法线图集(α 是 bulge 高度,常为 0)会被
    整张解码成 normalize(1,1,−0.05),色图边缘也会出预乘 halo(实测)。"""
    u8 = np.round(np.clip(img, 0, 1) * 255).astype('uint8')
    rgb = np.asarray(Image.fromarray(u8[..., :3], 'RGB')
                     .resize((w, h), Image.BILINEAR), np.float32) / 255.0
    a = np.asarray(Image.fromarray(u8[..., 3], 'L')
                   .resize((w, h), Image.BILINEAR), np.float32) / 255.0
    return np.dstack([rgb, a])


def shade_character(ctx: dict, sprite: CharSprite, foot_world,
                    sky_def: dict, sun_dir, gi: float, ev: float,
                    env_rgb, env_gain: float,
                    lights: list[dict] | None = None,
                    char_gi: float | None = None,
                    char_ref_intensity: float = 1.0,
                    flatten: float = 0.0, bulge: float = 0.22,
                    ao_contact: float = 0.0, ao_form: float = 0.0,
                    mirror: bool = False,
                    notes: list | None = None
                    ) -> tuple[np.ndarray, np.ndarray]:
    """把一帧立绘按运行时角色管线着色,返回 (显示域 sRGB rgb, alpha),
    分辨率 = 该角色在画面上的实际显示大小(worldHeight → q → ×ppu)。

    E_目标逐像素 = skyE(体天穹×自己法线) + ambientE(体AO) + giE·charGi
                   + sunE + lampE(与场景同一份灯、角色口径 march)
    out = sc3CharBase(图集) · E_目标 → 形体AO → from_hdr·2^ev(预览统一链)。
    `char_gi` None ⇒ 跟随 gi(运行时缺省口径);`sun_dir`/`sky_def` 是预览的
    运行时天空面板(与场景侧同一份)。"""
    from .check import _trilinear
    inp = ctx['inp']
    vol = ctx.get('volume')
    if not vol:
        raise ValueError('立绘着色需要体数据(重烘勾「含体积数据」)')
    if char_gi is None:
        char_gi = gi                     # uCharGi = def.charGi ?? def.gi
    qu_h = sprite.world_h_wu / float(inp.scene_per_wu)   # 角色高(q 单位)
    out_h = max(12, int(round(qu_h * inp.ppu)))
    out_w = max(6, int(round(out_h * sprite.rgba.shape[1]
                             / sprite.rgba.shape[0])))
    rgba = _resize_rgba(sprite.rgba, out_w, out_h)
    nrm = _resize_rgba(sprite.nrm, out_w, out_h)
    if mirror:
        rgba = rgba[:, ::-1]
        nrm = nrm[:, ::-1]
    alpha = rgba[..., 3]
    live = alpha > 1e-3
    idx = np.nonzero(live.ravel())[0]
    h, w = out_h, out_w
    rgb_out = np.zeros((h, w, 3), np.float32)
    if idx.size == 0:
        return rgb_out, alpha.astype(np.float32)

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

    # ---- 逐像素 q / P:脚点 + 高度沿世界 up(R[1,:] 即 (0,cosT,−sinT) 的
    #      全式)上抬,横向沿 q 的 x̂(运行时 qx 直接按像素算),z 再减
    #      ne.a·bulge(伪 3d 鼓包) ----
    Rm = np.asarray(inp.R, np.float64)
    q_f = np.asarray(foot_world, np.float64) @ Rm
    rr, cc = np.divmod(idx, w)
    hy = (h - 1 - rr) / max(h - 1, 1) * qu_h
    up_q = Rm[1, :]                       # 世界 up 在 q 中的方向(行向量约定)
    q_pix = (q_f[None, :] + hy[:, None] * up_q[None, :])
    q_pix[:, 0] += (cc - (w - 1) / 2.0) / float(inp.ppu)
    q_pix[:, 2] -= ne[:, 3] * float(bulge)
    P = q_pix @ Rm.T                      # q→世界(R 正交)

    # ---- 体数据逐像素三线性(ucSkyAt:天穹 SH-L1 / AO / GI,吃自己的法线) ----
    raw = vol['raw']
    nvox = len(raw['sky_a0'])
    M = np.concatenate([raw['sky_a0'][:, None], raw['sky_a1'],
                        raw['ao_a0'][:, None], raw['ao_a1'],
                        raw['gi_a0'], raw['gi_a1'].reshape(nvox, 9)], 1
                       ).astype(np.float32)
    t = _trilinear(M, vol['bounds'], vol['grid'], P)
    t0 = np.maximum(t[:, 0] + np.einsum('nd,nd->n', t[:, 1:4], n), 0.0)
    cap0 = np.maximum((1.0 + n[:, 1]) * 0.5, 1.0 / 255.0)
    V = np.clip(t0 / cap0, 0.0, 1.0)
    bent = t[:, 1:4] + 1e-6
    bent /= np.maximum(np.linalg.norm(bent, axis=-1, keepdims=True), 1e-12)
    wgt = 1.0 - (1.0 - V) ** 2
    nmix = bent * (1.0 - wgt[:, None]) + n * wgt[:, None] + 1e-6
    nmix /= np.maximum(np.linalg.norm(nmix, axis=-1, keepdims=True), 1e-12)
    sh = sky_irradiance_sh(dict(sky_def), sun_dir)
    b = np.asarray(sh_basis(nmix[:, 0].astype(np.float64),
                            nmix[:, 1].astype(np.float64),
                            nmix[:, 2].astype(np.float64)))
    sky_e = np.maximum(b.T @ sh, 0.0) * V[:, None]
    ao = np.clip(t[:, 4] + np.einsum('nd,nd->n', t[:, 5:8], n), 0.0, 1.0)
    amb_e = (np.asarray(env_rgb, np.float32)[None, :] * float(env_gain)
             * np.clip(0.28 + 0.72 * ao, 0.0, 1.2)[:, None])
    gi_e = np.maximum(t[:, 8:11] + np.einsum('ncd,nd->nc',
                                             t[:, 11:20].reshape(-1, 3, 3), n),
                      0.0) * np.float32(char_gi)

    # ---- 太阳 + 灯(与场景同一份数据、同一批 lc*、角色口径 march) ----
    direct_e = np.zeros((idx.size, 3), np.float32)
    lights = lights or []
    qu = 1.0 / float(inp.scene_per_wu)
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
    col_rgb = rgba.reshape(-1, 4)[idx]
    alb = srgb_to_linear(col_rgb[:, :3]
                         / np.maximum(col_rgb[:, 3:4], 1e-4))
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
    return rgb_out, alpha.astype(np.float32)
