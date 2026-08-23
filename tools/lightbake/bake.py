"""顶层编排：把 `input` → `trace` → `gather` → `volume` → `payload` 串成一次烘焙。

产出 `bundle`（内存里的全部中间量与产物），`payload.write_payload` 负责落盘，
`report.build_report` 负责预览，`check.run_checks` 负责自检 —— 三者共享同一份 bundle，
不重复计算。

工序与 `tools/scene_relight/bake_gbuffer.py::bake()` 逐字同一套（那是 v5 的参考实现），
差异只在：payload 版本 6、体积数据文件名 `char_volume.bin`、GI 通道改用不截断 tracer。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from . import const
from .encode import (decode_base, decode_log_hdr, encode_log_hdr, from_hdr,
                     linear_to_srgb, pick_log_params, resize_encoded, resize_f,
                     resize_rgb, srgb_to_linear, to_hdr)
from .gather import (apply_dehaze, bake_local_ao, direct_visibility, fit_haze,
                     fit_runtime_lights, solve_direct_light)
from .input import SceneInput, load, scene_paths
from .sky import make_sky_sampler, resolve_sky_spec
from .trace import trace_pixels
from .volume import bake_char_volume, char_grid_for

ROOT = Path(__file__).resolve().parents[2]


def _sky_with_gain(sky_of, gain: float):
    """把逃逸辐射整体乘 gain（与场景侧 E·gather_gain 同一个尺度）。"""
    return lambda dw, f=sky_of, g=gain: f(dw) * g


def bake_scene(sid: str, work_w: int = const.WORK_W,
               spp: int = const.GATHER_SPP,
               vol_density: int = 3,
               no_gi: bool = False,
               sky: dict | None = None,
               progress: bool = True,
               char_spp: int = const.CHAR_VOL_SPP) -> dict:
    """烘一个场景，返回 bundle。不写盘（写盘交给 `payload.write_payload`）。"""
    inp: SceneInput = load(sid, work_w)
    w, h = inp.work
    nw, nh = inp.native
    R = inp.R
    ppu, cx, cy = inp.ppu, inp.cx, inp.cy
    depth = inp.depth
    q = inp.q
    world = inp.world
    normal = inp.normal

    if progress:
        print(f'  [{sid}] work {w}x{h}  native {nw}x{nh}  ppu={ppu:.2f}', flush=True)

    bg_work = resize_rgb(inp.bg_srgb, (w, h)) if (w, h) != inp.native else inp.bg_srgb
    lin_work = srgb_to_linear(bg_work)
    # 必须先去霾：霾是被日光照亮的空气，不是表面。喂进 final gather 等于让远处一片
    # 亮灰当光源，近处会被它照亮。
    haze = fit_haze(lin_work, depth)
    lin_work = apply_dehaze(lin_work, depth, haze)
    hdr_work = to_hdr(lin_work)

    data = scene_paths(sid)['data']
    sky_spec = resolve_sky_spec(sid, data, sky)
    sky_of = make_sky_sampler(sky_spec, ROOT)

    # 一趟 MC 同时出辐照度与天穹传输（同一个积分的不同投影）
    gr = trace_pixels(q, normal, R, ppu, cx, cy, hdr_work, sky_of, spp)
    e_ind, vis, bent, vfit = gr.e, gr.vis, gr.bent, gr.vfit

    # 直射光：gather 出的 E 只有间接光，画里由直射造成的大尺度明暗除不掉，全留 base。
    sun = solve_direct_light(normal, vfit, hdr_work, e_ind)
    if sun['found']:
        sdir = np.asarray(sun['dir'], np.float32)
        S = (np.clip(normal @ sdir, 0.0, None) * direct_visibility(vfit, sdir)).astype(np.float32)
        e = e_ind + np.asarray(sun['radiance'], np.float32)[None, None, :] * S[..., None]
    else:
        e = e_ind

    t0 = vis * ((1.0 + normal[..., 1]) * 0.5)
    ao = bake_local_ao(q, normal, R, ppu, cx, cy)
    rt_fit = fit_runtime_lights(e, t0, ao)

    # 整体增益：E 的尺度本来就是自由的，取 p95(hdr/E) 让 base 的 p95 落在 1。
    ratio = (hdr_work / np.maximum(e, 1e-4)).max(-1)
    gather_gain = float(np.clip(np.percentile(ratio, const.GATHER_GAIN_PERCENTILE),
                                1.0, const.GATHER_GAIN_MAX))
    e = (e * gather_gain).astype(np.float32)

    # 先量化 E，再据量化后的 E 反推 base（顺序反了端到端就不再恒等）。
    e_scale, e_span = pick_log_params(e)
    e8 = encode_log_hdr(e, e_scale, e_span)
    e_q = decode_log_hdr(e8, e_scale, e_span)
    e_native = (decode_log_hdr(resize_encoded(e8, inp.native), e_scale, e_span)
                if (w, h) != inp.native else e_q)

    d_native = resize_f(depth, inp.native) if (w, h) != inp.native else depth
    lin_native = apply_dehaze(srgb_to_linear(inp.bg_srgb), d_native, haze)
    hdr_native = to_hdr(lin_native)

    # 比例基底。一个除法，没有别的。
    base = hdr_native / np.maximum(e_native, 1e-4)
    base_scale, base_span = pick_log_params(base)
    base8 = encode_log_hdr(base, base_scale, base_span)
    base_q = decode_base(base8, base_scale, base_span)

    # 存储精度体检（比的是去霾后的原画 —— 去霾是刻意的信息移除）。
    round_lin = from_hdr(base_q * e_native)
    err_all = np.abs(linear_to_srgb(round_lin) - linear_to_srgb(lin_native)) * 255.0
    roundtrip = {
        'mean_255': float(err_all.mean()),
        'p99_255': float(np.percentile(err_all, 99)),
        'max_255': float(err_all.max()),
    }

    # 实体空间数据。辐射场与场景侧同一个尺度（乘 gather_gain）。
    cells_xz = float(vol_density)
    cells_y = float(vol_density * 2)
    grid = char_grid_for(world, inp.char_wu, inp.band, cells_xz, cells_y)
    if progress:
        print(f'  [{sid}] 角色空间数据 {grid[0]}x{grid[1]}x{grid[2]}'
              f' = {grid[0] * grid[1] * grid[2]} 格（每角色高 {vol_density}）', flush=True)
    vol = bake_char_volume(depth, R, ppu, cx, cy, world, inp.band,
                           hdr_work * gather_gain, _sky_with_gain(sky_of, gather_gain),
                           inp.char_wu, no_gi=no_gi, grid=grid, char_spp=char_spp)

    e_lum = e_q @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    vb_max = float(max(np.abs(vfit[..., 1:]).max(), 1e-3))

    return {
        'sid': sid,
        'inp': inp,
        'bg_srgb': inp.bg_srgb,
        'lin_work': lin_work, 'lin_native': lin_native,
        'hdr_work': hdr_work, 'hdr_native': hdr_native,
        'depth': depth, 'depth_native': d_native,
        'normal': normal, 'q': q, 'world': world,
        'e_ind': e_ind, 'vis': vis, 'bent': bent, 'vfit': vfit,
        'sun': sun, 'e': e, 'e_native': e_native, 'e_q': e_q,
        'e8': e8, 'e_scale': e_scale, 'e_span': e_span,
        'ao': ao, 't0': t0, 'rt_fit': rt_fit,
        'gather_gain': gather_gain,
        'base': base, 'base8': base8, 'base_q': base_q,
        'base_scale': base_scale, 'base_span': base_span,
        'e_lum': e_lum, 'vb_max': vb_max,
        'haze': haze, 'sky_spec': sky_spec,
        'roundtrip': roundtrip,
        'volume': vol,
        'no_gi': no_gi, 'spp': spp, 'vol_density': vol_density,
        'work_w': work_w,
        'lighting': data.get('lighting') or {},
    }


def scene_payload_dir(sid: str) -> Path:
    return scene_paths(sid)['rt_dir'] / 'lighting3'
