"""自包含 HTML 预览（§11）：单文件，所有图 base64 内联成 `data:` URI，零外部请求。

浏览器没有可缓存的对象，文件变了内容就变了，**结构上不可能看到旧图**。

面板：
1. 每张产物 + 分位统计 + 越界比例
2. `原画 / E / base` 三联 + `base·E − 原画` 误差图
3. 遮蔽：`V`、`Bdir`、`vis_linear` 重建 vs 直接积分的差图
4. 实体体数据：体数据 V 作用到场景表面 + 与场景 V 的差、validity 图、若干高度切片
5. 程序性天空：天穹辐亮度球、9 个 SH 系数、若干法线方向辐照度、朝西/朝东比值
5b. 时刻预览：程序性天空 + 太阳在一天各时刻把场景打成「一边亮一边暗」的最终表现
6. 直射光扫描的完整评分表
7. 自检表（绿/红）
"""
from __future__ import annotations

import base64
import io
import json

import numpy as np
from PIL import Image

from .check import CheckResult
from .encode import from_hdr, linear_to_srgb, resize_f
from .payload import PAYLOAD_VERSION
from .shade import shade
from .sky import eval_sh, kelvin_to_linear_rgb, sky_irradiance_sh
from .volume import sample_transfer

_LUM = np.array([0.2126, 0.7152, 0.0722], np.float32)
_MAX_W = 512


def _resize_hdr(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 HDR（可 >1）逐通道双线性重采样（预览用，不裁剪）。"""
    return np.stack([resize_f(np.ascontiguousarray(a[..., c]), size)
                     for c in range(a.shape[-1])], -1)


def _sun_dir(el_deg: float, az_deg: float) -> np.ndarray:
    el = np.deg2rad(el_deg)
    az = np.deg2rad(az_deg)
    return np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)], np.float32)


def _time_of_day_presets() -> list[dict]:
    """一组「时刻」预设：太阳方位 + 程序性天空。目的只是演示「一边亮一边暗」。"""
    return [
        dict(label='清晨 6:00', el=8, az=90, sky=dict(profile=1.0, kelvin=4000, intensity=0.6,
            glowGain=2.0, glowTight=8, glowKelvin=3200, groundGain=0.25), sun=1.2),
        dict(label='上午 9:00', el=30, az=130, sky=dict(profile=0.7, kelvin=5200, intensity=1.0,
            glowGain=1.2, glowTight=6, glowKelvin=5200, groundGain=0.2), sun=1.5),
        dict(label='正午 12:00', el=60, az=180, sky=dict(profile=0.4, kelvin=6000, intensity=1.2,
            glowGain=0.6, glowTight=4, glowKelvin=6000, groundGain=0.2), sun=2.0),
        dict(label='下午 15:00', el=30, az=230, sky=dict(profile=0.7, kelvin=4800, intensity=1.0,
            glowGain=1.2, glowTight=6, glowKelvin=4800, groundGain=0.2), sun=1.5),
        dict(label='黄昏 18:00', el=8, az=270, sky=dict(profile=2.0, kelvin=3000, intensity=0.5,
            glowGain=2.5, glowTight=8, glowKelvin=2500, groundGain=0.3), sun=0.8),
        dict(label='夜晚 21:00', el=-12, az=270, sky=dict(profile=3.0, kelvin=20000, intensity=0.08,
            groundGain=0.15), sun=0.0),
    ]


def _to_u8(arr: np.ndarray) -> np.ndarray:
    return np.round(np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)


def _b64(arr: np.ndarray, mode: str = 'RGB', max_w: int = _MAX_W) -> str:
    """数组 → PNG → base64 data URI（必要时缩到 max_w 宽）。"""
    img = Image.fromarray(arr, mode=mode)
    if img.width > max_w:
        img = img.resize((max_w, max(1, round(img.height * max_w / img.width))), Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def _gray_b64(x: np.ndarray, lo: float | None = None, hi: float | None = None,
              max_w: int = _MAX_W) -> str:
    if lo is None or hi is None:
        lo, hi = (float(v) for v in np.percentile(x, [1, 99]))
    v = np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    return _b64(_to_u8(v), mode='L', max_w=max_w)


def _stats(x: np.ndarray) -> str:
    flat = x.ravel()
    p = np.percentile(flat, [1, 50, 95, 99])
    return (f'min={flat.min():.4g} p1={p[0]:.4g} p50={p[1]:.4g} '
            f'p95={p[2]:.4g} p99={p[3]:.4g} max={flat.max():.4g}')


def _clip_frac(u8: np.ndarray, one_sided_zero: bool = False) -> str:
    frac0 = float((u8 == 0).mean())
    frac255 = float((u8 == 255).mean())
    if one_sided_zero:
        return f'字节0={frac0:.2%}（=精确0） 撞顶={frac255:.2%}'
    return f'钳底={frac0:.2%} 撞顶={frac255:.2%}'


def _html_page(title: str, body: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<title>{title}</title>
<style>
 body {{ font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 20px;
        background: #101014; color: #e8e8ec; }}
 h1 {{ font-size: 18px; }} h2 {{ font-size: 15px; margin-top: 32px; border-bottom: 1px solid #333; }}
 .row {{ display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }}
 .card {{ background: #1b1b21; border-radius: 8px; padding: 12px; max-width: 560px; }}
 .card img {{ max-width: 100%; border-radius: 4px; }}
 .lbl {{ font-size: 12px; color: #9aa; margin: 6px 0 2px; }}
 .stat {{ font-size: 11px; color: #788; font-family: ui-monospace, monospace; }}
 table {{ border-collapse: collapse; font-size: 11px; }}
 td, th {{ border: 1px solid #333; padding: 2px 6px; text-align: right; font-family: ui-monospace, monospace; }}
 .ok {{ color: #4f4; }} .bad {{ color: #f55; font-weight: bold; }}
 .mono {{ font-family: ui-monospace, monospace; }}
</style></head><body>
<h1>{title}</h1>
{body}
</body></html>"""


def build_report(bundle: dict, results: list[CheckResult] | None = None,
                 sky_def: dict | None = None) -> str:
    b = bundle
    inp = b['inp']
    title = f'lightbake 预览 — {b["sid"]}（载荷 v{PAYLOAD_VERSION}）'
    body: list[str] = []

    # ---------------------------------------------------------------- 1 产物
    body.append('<h2>1 · 产物</h2><div class="row">')
    e_disp = linear_to_srgb(from_hdr(b['e_q']))
    body.append(f'<div class="card"><div class="lbl">irradiance.png（烘焙 GI，对数解码）</div>'
                f'<img src="{_b64(_to_u8(e_disp))}"><div class="stat">{_stats(b["e_lum"])}'
                f'<br>{_clip_frac(b["e8"])}</div></div>')
    base_disp = linear_to_srgb(from_hdr(b['base_q']))
    body.append(f'<div class="card"><div class="lbl">base.png（I/E，比例基底）</div>'
                f'<img src="{_b64(_to_u8(base_disp))}"><div class="stat">{_stats(b["base"])}'
                f'<br>{_clip_frac(b["base8"], one_sided_zero=True)}</div></div>')
    body.append(f'<div class="card"><div class="lbl">normal.png（n·0.5+0.5）</div>'
                f'<img src="{_b64(_to_u8(inp.normal * 0.5 + 0.5))}"></div>')
    occ = np.empty(b['bent'].shape[:2] + (4,), np.uint8)
    occ[..., :3] = _to_u8(b['bent'] * 0.5 + 0.5)
    occ[..., 3] = _to_u8(b['vis'])
    body.append(f'<div class="card"><div class="lbl">sky_occlusion.png（RGB=Bdir, A=V）</div>'
                f'<img src="{_b64(occ, mode="RGBA")}"><div class="stat">V: {_stats(b["vis"])}</div></div>')
    body.append(f'<div class="card"><div class="lbl">ao.png（局部 AO）</div>'
                f'<img src="{_gray_b64(b["ao"], 0.0, 1.0)}"><div class="stat">{_stats(b["ao"])}</div></div>')
    body.append('</div>')

    # ------------------------------------------------------------- 2 三联 + 误差
    body.append('<h2>2 · 原画 / E / base 三联</h2><div class="row">')
    src_disp = linear_to_srgb(b['lin_native'])
    body.append(f'<div class="card"><div class="lbl">原画（去霾后）</div>'
                f'<img src="{_b64(_to_u8(src_disp))}"></div>')
    e_nat_disp = linear_to_srgb(from_hdr(b['e_native']))
    body.append(f'<div class="card"><div class="lbl">E（辐照度，升采样到 native）</div>'
                f'<img src="{_b64(_to_u8(e_nat_disp))}"></div>')
    err = np.abs(b['base_q'] * b['e_native'] - b['lin_native'])
    err_lum = err @ _LUM
    body.append(f'<div class="card"><div class="lbl">|base·E − 原画|（×32）</div>'
                f'<img src="{_gray_b64(err_lum, 0.0, float(np.percentile(err_lum, 99))) }">'
                f'<div class="stat">p99={np.percentile(err_lum, 99):.4f}（线性亮度）</div></div>')
    body.append('</div>')

    # ------------------------------------------------------------- 3 遮蔽
    body.append('<h2>3 · 遮蔽</h2><div class="row">')
    body.append(f'<div class="card"><div class="lbl">V（余弦加权可见度）</div>'
                f'<img src="{_gray_b64(b["vis"], 0.0, 1.0)}"></div>')
    body.append(f'<div class="card"><div class="lbl">Bdir（bent 方向·0.5+0.5）</div>'
                f'<img src="{_b64(_to_u8(b["bent"] * 0.5 + 0.5))}"></div>')
    # vis_linear 重建（V(up)） vs 直接积分（V）差图
    v_recon = np.clip(b['vfit'][..., 0] + b['vfit'][..., 2] * 1.0, 0.0, 1.0)
    diff = np.abs(v_recon - b['vis'])
    body.append(f'<div class="card"><div class="lbl">vis_linear 重建 V(up) vs 直接 V 差</div>'
                f'<img src="{_gray_b64(diff, 0.0, float(np.percentile(diff, 99)))}">'
                f'<div class="stat">差中位={np.median(diff):.4f}</div></div>')
    body.append('</div>')

    # ------------------------------------------------------------- 4 体数据
    body.append('<h2>4 · 实体体数据</h2><div class="row">')
    vol = b['volume']
    nx, ny, nz = vol['grid']['nx'], vol['grid']['ny'], vol['grid']['nz']
    bnd = vol['bounds']
    # 一致性：把体数据的天空遮蔽通道 T(N)/cap0 直接作用到场景表面，对比场景 V
    world_f = b['world'].reshape(-1, 3)
    normal_f = b['normal'].reshape(-1, 3)
    a0s, a1s = sample_transfer(vol['a0'], vol['a1'], bnd, nx, ny, nz, world_f, 0)
    cap0 = np.maximum((1.0 + normal_f[:, 1]) * 0.5, 1.0 / 255.0)
    t = np.maximum(a0s + (a1s * normal_f).sum(-1), 0.0)
    v_vol = np.clip(t / cap0, 0.0, 1.0)
    scene_v = b['vis'].ravel()
    cons = np.abs(v_vol - scene_v).reshape(b['vis'].shape)
    deep = scene_v < 0.2
    deep_bias = float(np.median(v_vol[deep] - scene_v[deep])) if deep.any() else 0.0
    body.append(f'<div class="card"><div class="lbl">体数据天空遮蔽 V（作用到场景表面）</div>'
                f'<img src="{_gray_b64(v_vol.reshape(b["vis"].shape), 0.0, 1.0)}"></div>')
    body.append(f'<div class="card"><div class="lbl">|体数据 V − 场景 V|</div>'
                f'<img src="{_gray_b64(cons, 0.0, float(np.percentile(cons, 99)))}">'
                f'<div class="stat">差中位={np.median(cons):.4f}，深遮蔽偏差={deep_bias:+.4f}'
                f'（同一量、不同估计量：余弦加权 MC vs 均匀半球 L1，见方案 §5.9）</div></div>')
    # validity 若干切片
    ys = np.linspace(0, ny - 1, min(4, ny)).astype(np.int32)
    for yi in ys:
        body.append(f'<div class="card"><div class="lbl">validity 切片 y={yi}（白=有效）</div>'
                    f'<img src="{_gray_b64(vol["valid"][:, yi, :].T.astype(np.float32), 0.0, 1.0)}"></div>')
    # 天穹通道 T(up) 若干高度水平切片
    for yi in ys[:3]:
        zz, xx = np.meshgrid(np.linspace(bnd['z0'], bnd['z1'], nz),
                             np.linspace(bnd['x0'], bnd['x1'], nx), indexing='ij')
        yv = np.full(xx.shape, np.linspace(bnd['y0'], bnd['y1'], ny)[yi])
        pts = np.stack([xx.ravel(), yv.ravel(), zz.ravel()], -1).astype(np.float32)
        pa0, pa1 = sample_transfer(vol['a0'], vol['a1'], bnd, nx, ny, nz, pts, 0)
        upv = np.array([0.0, 1.0, 0.0], np.float32)
        tv = (pa0 + pa1 @ upv).reshape(xx.shape)
        body.append(f'<div class="card"><div class="lbl">T(up) 切片 y={yi}（天穹传输）</div>'
                    f'<img src="{_gray_b64(tv.T, 0.0, 1.0)}"></div>')
    body.append('</div>')

    # ------------------------------------------------------------- 5 天空
    body.append('<h2>5 · 程序性天空</h2>')
    sky_cfg = dict(sky_def or {})
    sun_dir = np.asarray(b['sun']['dir'], np.float32) if b['sun'].get('found') else None
    sh = sky_irradiance_sh(sky_cfg, sun_dir)
    # 辐亮度球（equirect 缩略）
    ELEV, AZ = 64, 128
    mus = -1 + 2 * (np.arange(ELEV) + 0.5) / ELEV
    azs = 2 * np.pi * (np.arange(AZ) + 0.5) / AZ
    ball = np.zeros((ELEV, AZ, 3), np.float32)
    for i, mu in enumerate(mus):
        h = np.sqrt(max(1 - mu * mu, 0))
        for j, a in enumerate(azs):
            d = np.array([h * np.sin(a), mu, h * np.cos(a)], np.float32)
            ball[i, j] = eval_sh(sh, d[0], d[1], d[2])
    ball_disp = linear_to_srgb(from_hdr(np.maximum(ball, 0.0)))
    body.append(f'<div class="card"><div class="lbl">天穹辐亮度球（SH-L2 重建）</div>'
                f'<img src="{_b64(_to_u8(ball_disp))}"></div>')
    # 9 个 SH 系数
    rows = ['<tr><th>k</th><th>R</th><th>G</th><th>B</th></tr>']
    for k in range(9):
        rows.append(f'<tr><td>{k}</td><td>{sh[k, 0]:.5f}</td>'
                    f'<td>{sh[k, 1]:.5f}</td><td>{sh[k, 2]:.5f}</td></tr>')
    body.append('<div class="card"><div class="lbl">9 个辐照度 SH 系数</div>'
                f'<table>{"".join(rows)}</table></div>')
    # 若干法线方向辐照度 + 朝西/朝东比值
    def irr(n):
        rgb = eval_sh(sh, n[0], n[1], n[2])
        return float(rgb @ _LUM)
    dirs = {'up': (0, 1, 0), 'down': (0, -1, 0)}
    if sun_dir is not None:
        west = sun_dir.copy(); west[1] = 0.0
        if np.linalg.norm(west) > 1e-6:
            west /= np.linalg.norm(west)
            dirs['toward-sun(西)'] = west
            dirs['away-sun(东)'] = -west
    line = []
    for name, n in dirs.items():
        line.append(f'{name} E={irr(np.asarray(n, np.float32)):.4f}')
    if 'toward-sun(西)' in dirs and 'away-sun(东)' in dirs:
        e_west = irr(np.asarray(dirs['toward-sun(西)'], np.float32))
        e_east = irr(np.asarray(dirs['away-sun(东)'], np.float32))
        ratio = e_west / max(e_east, 1e-9)
        line.append(f'西/东比值={ratio:.3f}')
    body.append(f'<div class="card"><div class="lbl">方向辐照度</div>'
                f'<div class="mono">{"; ".join(line)}</div></div>')

    # ------------------------------------------------- 5b 时刻预览
    body.append('<h2>5b · 时刻预览（程序性天空 + 太阳，gi=0 纯重打光）</h2>'
                '<div class="stat">gi=0 时输出 = base × (E_天光 + E_太阳 + E_环境)，'
                '看的就是换时刻时天空/太阳怎么把画面打成「一边亮一边暗」。</div><div class="row">')
    w, h = b['inp'].work
    base_w = _resize_hdr(b['base_q'], (w, h))
    src_w = _resize_hdr(b['lin_native'], (w, h))
    body.append(f'<div class="card"><div class="lbl">原画（去霾后，参考）</div>'
                f'<img src="{_b64(_to_u8(linear_to_srgb(src_w)))}"></div>')
    for p in _time_of_day_presets():
        sdir = _sun_dir(p['el'], p['az'])
        sh = sky_irradiance_sh(p['sky'], sdir)
        scolor = kelvin_to_linear_rgb(p['sky'].get('glowKelvin') or p['sky'].get('kelvin', 5500))
        rend = shade(base_w, b['e_q'], b['normal'], b['bent'], b['vis'], b['ao'], b['vfit'],
                     sh, gi=0.0, sun_dir=sdir, sun_color=scolor, sun_intensity=p['sun'])
        disp = linear_to_srgb(from_hdr(np.maximum(rend, 0.0)))
        body.append(f'<div class="card"><div class="lbl">{p["label"]}'
                    f'（太阳 el={p["el"]}° az={p["az"]}°）</div>'
                    f'<img src="{_b64(_to_u8(disp))}"></div>')
    body.append('</div>')

    # ------------------------------------------------------------- 6 直射光评分表
    body.append('<h2>6 · 直射光扫描评分表</h2>')
    st = b['sun'].get('score_table') or []
    if st:
        els = sorted({s['el'] for s in st})
        azs = sorted({s['az'] for s in st})
        by = {(s['el'], s['az']): s for s in st}
        rows = ['<tr><th>仰角\\方位</th>' + ''.join(f'<th>{a:.0f}°</th>' for a in azs) + '</tr>']
        for el in els:
            cells = []
            for az in azs:
                s = by.get((el, az))
                if s is None or s['sd'] is None:
                    cells.append('<td>—</td>')
                else:
                    cells.append(f'<td>{s["sd"]:.3f}</td>')
            rows.append(f'<tr><td>{el:.1f}°</td>' + ''.join(cells) + '</tr>')
        body.append('<div class="card"><div class="lbl">std(log base)，越小越好'
                    '（落回中心 = 正中格反而最小，见方案 §5.6）</div>'
                    f'<table>{"".join(rows)}</table></div>')
    else:
        body.append('<div class="card">无直射光（阴天 / 室内）。</div>')

    # ------------------------------------------------------------- 7 自检表
    body.append('<h2>7 · 自检</h2><table>'
                '<tr><th>#</th><th>检查</th><th>结果</th><th>详情</th></tr>')
    for r in results or []:
        cls = 'ok' if r.ok else 'bad'
        body.append(f'<tr><td>{r.cid}</td><td>{r.name}</td>'
                    f'<td class="{cls}">{"绿" if r.ok else "红"}</td><td>{r.detail}</td></tr>')
    body.append('</table>')

    return _html_page(title, ''.join(body))
