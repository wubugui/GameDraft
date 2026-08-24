"""自包含 HTML 预览(方案 §11.2)。

**单文件,所有图 base64 内联成 data: URI,零外部请求** —— 浏览器没有可缓存的
对象,文件变了内容就变了,结构上不可能看到旧图。七个面板:产物统计 / 恒等三联 /
遮蔽 / 体数据 / 程序性天空 / 直射光评分表 / 自检表。
"""
from __future__ import annotations

import base64
import datetime
import html
import io
import math

import numpy as np
from PIL import Image

from .encode import LUMA, linear_to_srgb
from .gather import vis_of_dir, vis_of_normal
from .payload import atomic_bytes
from .sky import eval_sh, sky_irradiance_sh, sky_radiance
from .trace import trace

UP = np.array([0.0, 1.0, 0.0], np.float32)
_MAX_W = 560          # 内联图统一缩到这个宽度,控制单文件体积


def _img_uri(arr: np.ndarray, mode: str = 'L') -> str:
    img = Image.fromarray(arr, mode=mode)
    if img.width > _MAX_W:
        img = img.resize((_MAX_W, max(1, round(img.height * _MAX_W / img.width))),
                         Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def _gray(x: np.ndarray, lo: float | None = None, hi: float | None = None) -> str:
    if lo is None or hi is None:
        lo, hi = (float(v) for v in np.percentile(x, [1, 99]))
    v = np.clip((x - lo) / max(hi - lo, 1e-9), 0, 1)
    return _img_uri(np.round(v * 255).astype(np.uint8), 'L')


def _rgb01(x: np.ndarray) -> str:
    return _img_uri(np.round(np.clip(x, 0, 1) * 255).astype(np.uint8), 'RGB')


def _stats_row(name: str, x: np.ndarray, extra: str = '') -> str:
    q = np.percentile(x, [0, 1, 50, 99, 100])
    return (f'<tr><td>{name}</td>'
            + ''.join(f'<td>{v:.4g}</td>' for v in q)
            + f'<td>{extra}</td></tr>')


def _fig(title: str, uri: str, note: str = '') -> str:
    cap = f'{html.escape(title)}'
    if note:
        cap += f' <span class="dim">{html.escape(note)}</span>'
    return f'<figure><img src="{uri}"><figcaption>{cap}</figcaption></figure>'


def build_html(ctx: dict) -> str:
    inp = ctx['inp']
    w, h = inp.work
    a0f, a1f = ctx['moments_smooth']
    e = ctx['e']
    e_q = ctx['e_q']
    ao = ctx['ao']
    vol = ctx['volume']
    e_lum = e_q @ LUMA
    parts: list[str] = []

    # ---------------- 1. 产物统计 ----------------
    over_a0 = float((a0f > 0.5 + 1 / 255).mean())
    over_a1 = float((np.abs(a1f) > 0.5 + 1 / 255).mean())
    rows = [
        _stats_row('E(亮度,量化后)', e_lum, f'编码 scale={ctx["e_scale"]:.4g} '
                                            f'span={ctx["e_span"]:.0f}'),
        _stats_row('遮蔽矩 a₀', a0f, f'越界(>½) {over_a0:.2%}'),
        _stats_row('遮蔽矩 |a₁|', np.abs(a1f), f'越界(>½) {over_a1:.2%}'),
        _stats_row('AO', ao),
        _stats_row('体·天穹 a₀', vol['raw']['sky_a0']),
        _stats_row('体·GI a₀(亮度)', vol['raw']['gi_a0'] @ LUMA),
    ]
    parts.append(
        '<h2>1 · 产物统计</h2><table><tr><th>量</th><th>min</th><th>p1</th>'
        '<th>p50</th><th>p99</th><th>max</th><th>备注</th></tr>'
        + ''.join(rows) + '</table>'
        + '<div class="figs">'
        + _fig('irradiance(E 亮度)', _gray(e_lum, 0.0, float(np.percentile(e_lum, 99))))
        + _fig('normal', _rgb01(ctx['normal'] * 0.5 + 0.5))
        + _fig('sky_moments:2·a₀', _gray(a0f * 2.0, 0.0, 1.0))
        + _fig('ao', _gray(ao, 0.0, 1.0))
        + '</div>')

    # ---------------- 2. 恒等三联 ----------------
    bg_work = ctx['lin_dehazed']
    base_l = (ctx['hdr_work'] @ LUMA) / np.maximum(e_q @ LUMA, 1e-6)
    # 恒等误差图 = 自检 #3 的镜像(原画字节 vs 运行时公式的字节级重构)——
    # 不是「base·E 自比」那种构造性恒零的图(审查纠正)
    # f32 近似版镜像(display 用;native 2048×1152 的 f64 中间量要 ~0.5GB,
    # 复审指出没必要 —— 权威的逐字节判定在自检 #3,那边才是 f64)
    from .const import HDR_MAX
    from .encode import resize_encoded, srgb_to_linear, to_hdr
    orig_b = np.round(inp.bg_srgb * 255.0).astype(np.int16)
    hdr32 = to_hdr(srgb_to_linear(inp.bg_srgb))
    e_nat_b = (resize_encoded(ctx['e8'], inp.native)
               if inp.work != inp.native else ctx['e8'].astype(np.float32))
    e_nat = (ctx['e_scale'] * np.exp2((e_nat_b / 255.0 - 0.5) * ctx['e_span'])
             ).astype(np.float32)
    disp = (hdr32 / np.maximum(e_nat, 1e-30)) * e_nat
    disp = disp / (1.0 + disp)
    got_b = np.round(linear_to_srgb(disp) * 255.0).astype(np.int16)
    byte_err = np.abs(got_b - orig_b).mean(-1).astype(np.float32)
    n_bad = int((got_b != orig_b).sum())
    parts.append(
        '<h2>2 · 原画 / E / base(base 不落盘,运行时现算)</h2><div class="figs">'
        + _fig('原画(去霾后,work)', _rgb01(linear_to_srgb(bg_work)))
        + _fig('E(亮度)', _gray(e_lum, 0.0, float(np.percentile(e_lum, 99))))
        + _fig('base 亮度(log 灰阶)', _gray(np.log2(np.maximum(base_l, 1e-6))))
        + _fig('gi=1 字节误差 ×64(自检 #3 的 f32 显示近似)',
               _gray(byte_err * 64.0, 0.0, 255.0),
               f'不同字节 {n_bad}(f32 近似,可能多出零星 ±1;'
               f'逐字节权威判定看自检 #3)')
        + '</div>')

    # ---------------- 3. 遮蔽 ----------------
    vis_up = vis_of_normal(a0f, a1f, np.broadcast_to(UP, a0f.shape + (3,)))
    bent = a1f / np.maximum(np.linalg.norm(a1f, axis=-1, keepdims=True), 1e-9)
    # 矩重建 vs 直接判定:探针方向的**精确单射线** vis(0/1)—— 良定义的
    # 被估对象本身,不再用手捏的锥形 MC 当参照(审查纠正:那个没有 pdf,
    # 不是任何积分的无偏估计)。
    probe = np.array([math.cos(math.radians(30)), math.sin(math.radians(30)), 0.0],
                     np.float32)
    sub = (slice(None, None, 4), slice(None, None, 4))
    pq = np.ascontiguousarray(inp.q[sub].reshape(-1, 3))
    dirs = np.broadcast_to(probe, (len(pq), 3))
    r = trace(pq, np.ascontiguousarray(dirs) @ inp.R, ctx['field'])
    v_direct = r.escaped.reshape(inp.q[sub].shape[:2]).astype(np.float32)
    v_recon = vis_of_dir(a0f[sub], a1f[sub], probe)     # 闭式的唯一实现处
    parts.append(
        '<h2>3 · 遮蔽(全部由矩 (a₀,a₁) 闭式导出)</h2><div class="figs">'
        + _fig('2·a₀ 场(§6.3 验收 buffer 同式)', _gray(a0f * 2.0, 0.0, 1.0))
        + _fig('V(N=up)', _gray(vis_up, 0.0, 1.0))
        + _fig('Bdir', _rgb01(bent * 0.5 + 0.5))
        + _fig('V_dir(30°,+x)重建', _gray(v_recon, 0.0, 1.0))
        + _fig('同方向精确单射线 vis(0/1)', _gray(v_direct, 0.0, 1.0))
        + _fig('|重建−精确| 差图', _gray(np.abs(
            v_recon - v_direct), 0.0, 0.5),
            f'中位 {np.median(np.abs(v_recon - v_direct)):.4f}'
            f'(L1 截断:连续重建 vs 二值真值,边界带天然非零)')
        + '</div>')

    # ---------------- 4. 体数据 ----------------
    g = vol['grid']
    nx, ny, nz = g['nx'], g['ny'], g['nz']
    a0v = vol['raw']['sky_a0'].reshape(nx, ny, nz)
    invv = vol['raw']['invalid'].reshape(nx, ny, nz)
    slices = ''
    for frac in (0.15, 0.45, 0.75):
        iy = min(ny - 1, int(round(frac * (ny - 1))))
        slices += _fig(f'2·a₀ 水平切片 y[{iy}]/{ny}',
                       _gray(np.kron(a0v[:, iy, :].T * 2.0, np.ones((4, 4))), 0.0, 1.0))
    slices += _fig('validity(白=被埋)',
                   _gray(np.kron(invv[:, min(ny - 1, int(0.15 * (ny - 1))), :]
                                 .T.astype(np.float32), np.ones((4, 4))), 0.0, 1.0),
                   f"覆盖率 {vol['validity_coverage']:.3f} "
                   f"dilation {vol['dilation_iters']} 轮")
    # 表面一致性
    from .check import _trilinear
    pw = inp.world[sub].reshape(-1, 3).astype(np.float64)
    tri = _trilinear(np.concatenate([vol['raw']['sky_a0'][:, None],
                                     vol['raw']['sky_a1']], 1),
                     vol['bounds'], vol['grid'], pw)
    v_vol = np.clip(tri[:, 0] + tri[:, 2], 0.0, 1.0).reshape(v_direct.shape)
    v_scene = np.clip(a0f[sub] + a1f[sub] @ UP, 0.0, 1.0)
    slices += _fig('|体@表面 − 场景| T(up)', _gray(np.abs(
        v_vol - v_scene).astype(np.float32), 0.0, 0.3),
        f'中位 {np.median(np.abs(v_vol - v_scene)):.4f}')
    parts.append(f'<h2>4 · 实体空间数据({nx}×{ny}×{nz},'
                 f'{nx * ny * nz} 格)</h2><div class="figs">{slices}</div>')

    # ---------------- 5. 程序性天空 ----------------
    sky_def = None
    try:
        import json
        sc = json.loads(inp.scene_json.read_text(encoding='utf-8'))
        sky_def = (sc.get('lighting') or {}).get('sky')
    except Exception:                                  # noqa: BLE001
        pass
    had_sky_block = bool(sky_def)
    sky_def = dict(sky_def or {})
    demo_note = ''
    if not sky_def.get('intensity'):
        # 如实标注,不伪造;区分「没配 sky 块」与「intensity=0」两种现实
        demo_note = (('本场景 lighting.sky.intensity = 0(程序性天空未启用);'
                      if had_sky_block else
                      '本场景没有 lighting.sky 块(或读取失败);')
                     + '以下为 intensity=1 的示意投影,非本场景实态。')
        sky_def['intensity'] = 1.0
        sky_def.setdefault('profile', 1.0)
    # 日侧辉光需要太阳方向 —— 用直射光反解的结果,漏传等于永远看不到黄昏不对称
    sun_dir = ctx['sun'].get('dir') if ctx['sun'].get('found') else None
    sh = sky_irradiance_sh(sky_def, sun_dir)
    th = np.linspace(0, math.pi, 90)
    ph = np.linspace(-math.pi, math.pi, 180)
    TH, PH = np.meshgrid(th, ph, indexing='ij')
    nxs = np.sin(TH) * np.sin(PH)
    nys = np.cos(TH)
    nzs = np.sin(TH) * np.cos(PH)
    img = np.zeros(TH.shape + (3,), np.float32)
    for i in range(TH.shape[0]):
        for k in range(3):
            b = np.stack([np.full(PH.shape[1], 0.2820948),
                          0.4886025 * nys[i], 0.4886025 * nzs[i], 0.4886025 * nxs[i],
                          1.0925484 * nxs[i] * nys[i], 1.0925484 * nys[i] * nzs[i],
                          0.3153916 * (3 * nzs[i] ** 2 - 1), 1.0925484 * nxs[i] * nzs[i],
                          0.5462742 * (nxs[i] ** 2 - nys[i] ** 2)])
            img[i, :, k] = np.maximum(sh[:, k] @ b, 0.0)
    peak = max(float(img.max()), 1e-9)
    lum_w = float((eval_sh(sh, 1, 0, 0) * LUMA).sum())
    lum_e = float((eval_sh(sh, -1, 0, 0) * LUMA).sum())
    coef_rows = ''.join(
        f'<tr><td>c{k}</td>' + ''.join(f'<td>{sh[k, c]:+.4f}</td>' for c in range(3))
        + '</tr>' for k in range(9))
    # 天穹**辐亮度**球(§11.2 面板 5 的第一项;辐照度球是它的 SH 卷积)
    rad = sky_radiance(sky_def, np.stack([nxs.ravel(), nys.ravel(),
                                          nzs.ravel()], 1), sun_dir)
    rad_img = rad.reshape(TH.shape + (3,)).astype(np.float32)
    rad_peak = max(float(rad_img.max()), 1e-9)
    parts.append(
        '<h2>5 · 程序性天空(运行时 SH-L2 的 CPU 镜像)</h2>'
        + (f'<p class="dim">{html.escape(demo_note)}</p>' if demo_note else '')
        + '<div class="figs">'
        + _fig('天穹辐亮度球 L(ω)(lat-long,按峰值归一)', _rgb01(rad_img / rad_peak))
        + _fig('辐照度球(SH-L2 卷积后,按峰值归一)', _rgb01(img / peak))
        + '</div>'
        + f'<p>朝西 {lum_w:.4f} / 朝东 {lum_e:.4f} / 比值 '
          f'{lum_w / max(lum_e, 1e-9):.2f};朝上 '
          f'{float((eval_sh(sh, 0, 1, 0) * LUMA).sum()):.4f};朝下 '
          f'{float((eval_sh(sh, 0, -1, 0) * LUMA).sum()):.4f}</p>'
        + '<table><tr><th>系数</th><th>R</th><th>G</th><th>B</th></tr>'
        + coef_rows + '</table>')

    # ---------------- 6. 直射光评分表 ----------------
    sun = ctx['sun']
    scan = sun.get('scan') or []
    els = sorted({r['elevation_deg'] for r in scan})
    azs = sorted({r['azimuth_deg'] for r in scan})
    lut = {(r['elevation_deg'], r['azimuth_deg']): r for r in scan}
    best_sd = min((r['sd'] for r in scan if r['sd'] is not None), default=None)
    trs = ''
    for el in els:
        tds = ''
        for az in azs:
            r = lut.get((el, az), {})
            sd = r.get('sd')
            if sd is None:
                tds += f'<td class="dim">{html.escape(r.get("note", "—"))}</td>'
            else:
                cls = ' class="best"' if sd == best_sd else ''
                tds += f'<td{cls}>{sd:.4f}</td>'
        trs += f'<tr><th>{el:.0f}°</th>{tds}</tr>'
    head = ''.join(f'<th>{az:.0f}°</th>' for az in azs)
    found = ('found=%s  方向 el=%.1f° az=%.1f°  radiance=%s  drop=%.3f'
             % (sun['found'], sun.get('elevation_deg', 0), sun.get('azimuth_deg', 0),
                ['%.3f' % v for v in sun.get('radiance', [0, 0, 0])],
                sun.get('drop', 0))) if sun['found'] else html.escape(sun.get('note', ''))
    parts.append(
        f'<h2>6 · 直射光扫描(完整评分表,std(log base),小者优)</h2>'
        f'<p>{found}</p>'
        f'<div class="scroll"><table><tr><th>仰角\\方位</th>{head}</tr>{trs}</table></div>')

    # ---------------- 6b. 最终渲染预览(§6.1 镜像,无解析灯) ----------------
    # 审查 [14]:preview.py 的「唯一实现」必须同时喂视口与存档 —— report 没有
    # 最终渲染时,§11.1「视口与 report 渲的是同一份数据」只对了一半。
    from .preview import TIME_PRESETS, base_of_ctx, identity_check, shade_final
    base_rgb, _bg = base_of_ctx(ctx)
    a0f_r, a1f_r = ctx['moments_smooth']
    figs_r = ''
    for name, sky_def, sun_dir, ev in TIME_PRESETS:
        img_r = shade_final(base_rgb, ctx['e_q'], a0f_r, a1f_r,
                            ctx['inp'].normal, sky_def, sun_dir,
                            gi=0.15, ev=ev)
        figs_r += _fig(f'{name}(gi=0.15, ev{ev:+.1f})', _rgb01(img_r))
    scene_sky = None
    try:
        import json as _json
        _sc = _json.loads(ctx['inp'].scene_json.read_text(encoding='utf-8'))
        scene_sky = (_sc.get('lighting') or {}).get('sky')
    except Exception:                                  # noqa: BLE001
        pass
    if scene_sky and scene_sky.get('intensity'):
        sun_dir_s = ctx['sun'].get('dir') if ctx['sun'].get('found') else None
        figs_r += _fig('场景自身 lighting.sky(gi=0.15)',
                       _rgb01(shade_final(base_rgb, ctx['e_q'], a0f_r, a1f_r,
                                          ctx['inp'].normal, scene_sky,
                                          sun_dir_s, gi=0.15)))
    ident_diff = identity_check(ctx)
    parts.append(
        '<h2>6b · 最终渲染预览(§6.1 镜像,无解析灯;与 GUI 视口同一份 '
        'preview.shade_final)</h2>'
        f'<p class="dim">恒等锚:gi=1 + 天光 0 与原画的字节差 = {ident_diff}'
        '(应为 0 或仅 255 饱和位;逐字节权威判定在自检 #3)</p>'
        f'<div class="figs">{figs_r}</div>')

    # ---------------- 7. 自检表 ----------------
    mark = {'pass': ('✓', 'ok'), 'warn': ('⚠', 'warn'), 'fail': ('✗', 'bad')}
    chk = ''.join(
        f'<tr class="{mark[r["status"]][1]}"><td>{mark[r["status"]][0]}</td>'
        f'<td>#{r["id"]}</td><td>{html.escape(r["name"])}</td>'
        f'<td>{html.escape(r["detail"])}</td></tr>'
        for r in ctx.get('checks', []))
    parts.append('<h2>7 · 自检</h2><table><tr><th></th><th>#</th><th>检查</th>'
                 '<th>结果</th></tr>' + chk + '</table>')

    tm = ctx.get('timing', {})
    meta_line = (f"v{ctx['meta']['version']} · work {w}×{h} · gain "
                 f"{ctx['gain']:.2f} · spp {ctx['spp']}/{ctx['moment_spp']} · "
                 f"ev_paint {ctx['exposure']['ev_paint']:+.2f} · "
                 f"gather {tm.get('gather_s')}s + moments {tm.get('moments_s')}s + "
                 f"ao {tm.get('ao_s')}s + volume {tm.get('volume_s')}s · "
                 + datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))
    fail_banner = ''
    if ctx.get('failed'):
        fail_banner = ('<p style="background:#5a1f1f;color:#f0c0c0;padding:8px '
                       '12px;border:1px solid #a33">⚠ 本次烘焙自检有红,'
                       '<b>载荷未写入</b> —— 本页描述的是这次失败的烘焙;'
                       '同目录的 meta.json/图(若有)属于更早的一次成功烘焙,'
                       '两者不是同代。</p>')
    return ('<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">'
            f'<title>lightbake · {html.escape(ctx["sid"])}</title><style>'
            'body{background:#14151a;color:#d8d5cc;font:14px/1.6 system-ui;'
            'margin:24px auto;max-width:1240px;padding:0 16px}'
            'h1{font-size:20px}h2{font-size:16px;margin-top:32px;'
            'border-bottom:1px solid #333;padding-bottom:4px}'
            'table{border-collapse:collapse;font-size:12px}'
            'td,th{border:1px solid #333;padding:3px 8px;text-align:right}'
            'th{background:#1d1f26}figure{display:inline-block;margin:6px;'
            'vertical-align:top;max-width:280px}figure img{max-width:280px;'
            'image-rendering:auto;border:1px solid #333}'
            'figcaption{font-size:11px;color:#9a968c}.figs{margin:8px 0}'
            '.dim{color:#666}.best{background:#274427;font-weight:bold}'
            '.ok td{color:#9c6}.warn td{color:#da3}.bad td{color:#e66}'
            '.scroll{overflow-x:auto}</style></head><body>'
            f'<h1>lightbake · {html.escape(ctx["sid"])}</h1>'
            + fail_banner
            + f'<p class="dim">{meta_line}</p>'
            + ''.join(parts) + '</body></html>')


def write_report(ctx: dict) -> None:
    html_text = build_html(ctx)
    atomic_bytes(ctx['out_dir'] / 'preview' / 'report.html',
                 html_text.encode('utf-8'))
