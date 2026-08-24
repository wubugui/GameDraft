"""bake 全链编排 —— GUI 与 CLI 调的同一条函数链(§11.1 的「壳」原则)。

流程(§5 的施工序):装载 → 去霾 → HDR 展开 → 天空 → E gather(march 半 +
天空半)→ 遮蔽矩 → 局部 AO → 直射光反解 → gather_gain → 曝光标定 →
编码 → 实体空间数据 → 落盘 → 自检(红就非零退出)→ 预览。
"""
from __future__ import annotations

import math
import sys
import time
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter

from . import check as check_mod
from . import input as input_mod
from . import payload
from .const import (AO_RANGE, AO_SPP, CHAR_VOL_SPP, GATHER_SEED, GATHER_SPP,
                    HDR_MAX, MOMENT_SPP, WORK_W)
from .encode import (decode_log_hdr, encode_log_hdr, pick_log_params, resize_rgb,
                     srgb_to_linear, to_hdr)
from .gather import (apply_dehaze, combine_e, compose_sun_e, exposure_of,
                     fit_haze, gather_gain_of, gather_scene_e, local_ao,
                     sky_moments, smooth_moments, solve_direct_light)
from .sampling import point_keys
from .sky import make_sky_sampler
from .trace import DepthField
from .volume import bake_volume

ROOT = input_mod.ROOT


def _say(msg: str) -> None:
    """GBK 控制台防线(§14 已知坑的新踩法,复审抓到):⚠/✓ 这类符号不在 GBK
    里,裸 print 一个告警就能 UnicodeEncodeError 把整场烘焙炸掉 ——
    编码失败就降级替换,日志永远不许杀 bake。"""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or 'ascii'
        print(msg.encode(enc, 'replace').decode(enc), flush=True)


def _progress(quiet: bool):
    if quiet:
        return None
    last = {}

    def cb(stage: str, i: int, n: int) -> None:
        if i == n or i % max(1, n // 4) == 0:
            if last.get(stage) != i:
                last[stage] = i
                _say(f'    {stage} {i}/{n}')
    return cb


def bake_scene(sid: str, *, work_w: int = WORK_W, spp: int = GATHER_SPP,
               sky_override: dict | None = None, no_gi: bool = False,
               vol_density: float | None = None, out_root: Path | None = None,
               write: bool = True, run_checks: bool = True,
               heavy_checks: bool = False, make_report: bool = True,
               with_volume: bool = True, quiet: bool = False) -> dict:
    """烘一个场景。返回 ctx(meta + 全部中间量,check/report/GUI 共用)。

    `out_root`:验证/实验用的替代输出根(缺省 = 正式路径
    `public/resources/runtime/scenes/<sid>/lighting3`)。
    `with_volume=False`:只出场景侧(GUI 首帧视口用,不写盘/不自检/不出 report
    —— 三者都要体数据,强制关掉)。
    """
    if not with_volume:
        write = run_checks = make_report = False
    t_start = time.time()
    prog = _progress(quiet)
    t0 = time.time()
    inp = input_mod.load(sid, work_w)
    t_load = time.time() - t0
    w, h = inp.work
    if not quiet:
        _say(f'  [{sid}] work {w}x{h}  ppu={inp.ppu:.2f}')
    field = DepthField.build(inp.depth, inp.ppu, inp.cx, inp.cy)
    Q = inp.q.reshape(-1, 3)
    N = inp.normal.reshape(-1, 3)
    keys = point_keys(Q)

    # ---- §5.1 去霾(必须在 gather 之前;霾是被日光照亮的空气,不是表面)----
    bg_work = resize_rgb(inp.bg_srgb, (w, h)) if (w, h) != inp.native else inp.bg_srgb
    lin_work = srgb_to_linear(bg_work)
    haze = fit_haze(lin_work, inp.depth)
    lin_dehazed = apply_dehaze(lin_work, inp.depth, haze)
    hdr_work = to_hdr(lin_dehazed)

    # ---- §5.3 烘焙期天空(GUI 里调、存回场景 JSON;CLI 读同一份)----
    sky_spec = input_mod.resolve_sky_spec(inp, sky_override)
    sky_of = make_sky_sampler(sky_spec, ROOT)

    # ---- §5.5 E gather:march 半(缓存)+ 天空半(§5.12 的重估结构)----
    if sky_spec.get('_source') == 'default' and not quiet:
        _say(f'  ⚠ [{sid}] 场景无 lighting.bakeSky,用 DEFAULT_SKY(白 ×0.05)——'
             f'在 GUI 里调定并存回场景 JSON(§5.3)')
    t0 = time.time()
    cache = gather_scene_e(Q, N, inp.R, field, hdr_work, spp, (h, w),
                           progress=prog)
    e_ind = combine_e(cache, sky_of)
    t_gather = time.time() - t0

    # ---- §5.5 遮蔽矩(与实体侧同一个估计器,独立一趟,不搭余弦射线便车)----
    t0 = time.time()
    a0_raw_f, a1_raw_f = sky_moments(Q, inp.R, field, spp=MOMENT_SPP, progress=prog)
    a0_raw = a0_raw_f.reshape(h, w)
    a1_raw = a1_raw_f.reshape(h, w, 3)
    a0f, a1f = smooth_moments(a0_raw, a1_raw)
    t_moments = time.time() - t0

    # ---- §5.8 局部 AO ----
    t0 = time.time()
    ao_flat = local_ao(Q, N, inp.R, field, spp=AO_SPP, progress=prog)
    ao = gaussian_filter(ao_flat.reshape(h, w), 0.8)
    ao = np.clip(ao, 0.0, 1.0).astype(np.float32)
    t_ao = time.time() - t0

    # ---- §5.6 直射光反解(方向遮蔽由矩闭式导出;组合走单一实现)----
    t0 = time.time()
    sun = solve_direct_light(inp.normal, a0f, a1f, hdr_work, e_ind, progress=prog)
    t_sun = time.time() - t0
    # ⚠ meta 里的 sun.radiance 是**乘 gain 之前**的量(其余辐射量都是 post-gain),
    #   标记出来免得消费者拿错尺度。
    sun['radiance_scale'] = 'pre-gain(烘入 E 的实际量还要 ×gather.gain)'
    e = compose_sun_e(e_ind, inp.normal, a0f, a1f, sun)

    # ---- §5.7 整体增益(尺度约定)+ §5.11 曝光标定 ----
    gain = gather_gain_of(hdr_work, e)
    e = (e * gain).astype(np.float32)
    exposure = exposure_of(e)

    # ---- §5.10 编码(先量化 E;base 不落盘,运行时由原画 ÷ E_q 现算)----
    t0 = time.time()
    e_scale, e_span = pick_log_params(e)
    e8 = encode_log_hdr(e, e_scale, e_span)
    e_q = decode_log_hdr(e8, e_scale, e_span)
    t_encode = time.time() - t0

    # ---- §5.9 实体空间数据(辐射与场景同尺度:整体乘 gain)----
    t0 = time.time()
    hdr_gained = (hdr_work * gain).astype(np.float32)
    if vol_density is not None and vol_density <= 0:
        raise ValueError(f'--vol-density 必须 > 0,拿到 {vol_density}')
    if with_volume:
        vol = bake_volume(
            inp.world, inp.R, field, hdr_gained,
            lambda dw, f=sky_of, g=gain: np.asarray(f(dw), np.float32) * g,
            inp.char_wu, inp.band, spp=CHAR_VOL_SPP, no_gi=no_gi,
            **({'cells_xz': vol_density} if vol_density is not None else {}),
            progress=prog)
    else:
        vol = None
    t_volume = time.time() - t0

    from .const import HAZE_KEEP
    ctx = {
        'sid': sid, 'inp': inp, 'field': field, 'keys': keys,
        'bake_params': {'work_w': work_w, 'spp': spp,
                        'sky_override': sky_override, 'no_gi': no_gi,
                        'vol_density': vol_density},
        # trans_floor:apply_dehaze 的透射率下限(恢复步 /max(trans, 0.15),
        # 与被替换的现役实现同式)—— 记进 meta,回溯可查
        'haze': {**haze, 'keep': HAZE_KEEP, 'trans_floor': 0.15},
        'sky_spec': sky_spec, 'sky_of': sky_of,
        'hdr_work': hdr_work, 'lin_dehazed': lin_dehazed, 'lin_raw': lin_work,
        'cache': cache, 'e_ind': e_ind, 'e': e, 'e8': e8, 'e_q': e_q,
        'e_scale': e_scale, 'e_span': e_span,
        'moments_raw': (a0_raw, a1_raw), 'moments_smooth': (a0f, a1f),
        'ao': ao, 'normal': inp.normal,
        'sun': sun, 'gain': gain, 'exposure': exposure,
        'volume': vol,
        'spp': spp, 'seed': GATHER_SEED, 'moment_spp': MOMENT_SPP,
        'ao_spp': AO_SPP, 'ao_range': AO_RANGE, 'hdr_max': HDR_MAX,
        'timing': {'load_s': round(t_load, 2),
                   'encode_s': round(t_encode, 3),
                   'gather_s': round(t_gather, 2),
                   'moments_s': round(t_moments, 2),
                   'ao_s': round(t_ao, 2), 'sun_s': round(t_sun, 2),
                   'volume_s': round(t_volume, 2)},
    }

    out_dir = (Path(out_root) / sid / 'lighting3' if out_root
               else inp.rt_dir / 'lighting3')
    ctx['out_dir'] = out_dir

    failed = False
    if run_checks:
        t0 = time.time()
        results = check_mod.run_all(ctx, heavy=heavy_checks)
        ctx['timing']['checks_s'] = round(time.time() - t0, 2)
        ctx['checks'] = results
        check_mod.print_table(results, quiet=quiet)
        failed = any(r['status'] == 'fail' for r in results)

    # meta 在自检计时之后再组装:timing 整块进 meta(§13 P1/P3 的基准要有归档载体)
    if with_volume:
        ctx['meta'] = payload.build_meta(ctx)
        products = payload.build_products(ctx)
        ctx['products'] = products
    else:
        ctx['meta'] = None
        products = ctx['products'] = None

    if failed:
        if write:
            _say(f'  ✗ [{sid}] 自检有红,产物**不落盘**(report 照出,'
                 f'注意它描述的是这次失败烘焙,不是目录里的旧载荷)')
    elif write:
        payload.write_payload(out_dir, products, ctx['meta'])
        if not quiet:
            total = sum(len(v) for v in products.values())
            _say(f'  [{sid}] 载荷 {total / 1e6:.2f} MB → {out_dir}')

    if make_report:
        # 自检红更要出 report —— 它就是判读失败用的工具(载荷仍然不写)
        t0 = time.time()
        from . import report as report_mod
        report_mod.write_report(ctx)
        ctx['timing']['report_s'] = round(time.time() - t0, 2)

    ctx['failed'] = failed
    if not quiet:
        tm = ctx['timing']
        _say(f'  [{sid}] 总耗时 {time.time() - t_start:.1f}s '
             f'(gather {t_gather:.1f} + moments {t_moments:.1f} + ao {t_ao:.1f} '
             f'+ sun {t_sun:.1f} + volume {t_volume:.1f}'
             f' + checks {tm.get("checks_s", 0)})')
    return ctx
