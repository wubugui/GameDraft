"""自检(方案 §10):`bake` 结束必跑,有红产物不落盘、CLI 非零退出。

每条自检返回 {'id','name','status'('pass'/'warn'/'fail'),'detail'}。
警报类(#6 阈值待定、#11 残留相关)只 warn 不 fail。

⚠ `base·E ≡ 原画` 恒真是零信息量的(乘性歧义的复述),不当「E 对」的证据;
  真正的判据是 #11 的残留相关与换光重渲染(§10 尾注)。
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

import numpy as np

from .const import HDR_MAX, MOMENT_SPP
from .encode import LUMA, decode_moments, encode_moments, resize_encoded
from .gather import combine_e, gather_scene_e, sky_moments, vis_of_normal
from .input import ROOT
from .sky import make_sky_sampler, sky_irradiance_sh

PKG = Path(__file__).resolve().parent
UP = np.array([0.0, 1.0, 0.0], np.float32)


def _res(cid: str, name: str, ok: bool | None, detail: str,
         warn: bool = False) -> dict:
    status = 'warn' if warn else ('pass' if ok else 'fail')
    return {'id': cid, 'name': name, 'status': status, 'detail': detail}


# ---------------------------------------------------------------- 各条自检

def check_1_2_open_cells(ctx: dict) -> list[dict]:
    sc = ctx['volume']['selfcheck']
    a0, t_up = sc['open_a0'], sc['open_T_up']
    out = []
    if a0 < 0.45:
        out.append(_res('1', '无遮挡格点 a0', None,
                        f'a0={a0:.4f} —— 场景无开阔格点(室内?),检查不适用', warn=True))
        out.append(_res('2', '无遮挡格点 T(up)', None,
                        f'T(up)={t_up:.4f},同上', warn=True))
        return out
    out.append(_res('1', '无遮挡格点 a0 = 0.5±1e-3',
                    abs(a0 - 0.5) <= 1e-3, f'a0={a0:.5f}'))
    out.append(_res('2', '无遮挡格点 T(up) = 1±2e-3',
                    abs(t_up - 1.0) <= 2e-3, f'T(up)={t_up:.5f}'))
    return out


def check_3_gi1_identity(ctx: dict) -> dict:
    """gi=1 恒等:运行时公式的 CPU 镜像逐字节等于原画(§5.7 base 不落盘)。

    镜像用 float64(base 在内存全精度):(to_hdr(x)/E_q)·E_q 精确抵消。
    """
    inp = ctx['inp']
    bg = inp.bg_srgb.astype(np.float64)
    orig_bytes = np.round(inp.bg_srgb * 255.0).astype(np.uint8)
    lin = np.where(bg <= 0.04045, bg / 12.92, ((bg + 0.055) / 1.055) ** 2.4)
    hdr = lin / np.maximum(1.0 - lin, 1.0 / HDR_MAX)
    e8 = ctx['e8']
    if inp.work != inp.native:
        e_nat_b = resize_encoded(e8, inp.native).astype(np.float64)
    else:
        e_nat_b = e8.astype(np.float64)
    e_nat = ctx['e_scale'] * np.exp2((e_nat_b / 255.0 - 0.5) * ctx['e_span'])
    base = hdr / e_nat                              # 无钳位、无上界(制作人铁令)
    disp_hdr = base * e_nat
    disp_lin = disp_hdr / (1.0 + disp_hdr)
    srgb = np.where(disp_lin <= 0.0031308, disp_lin * 12.92,
                    1.055 * np.clip(disp_lin, 0.0, 1.0) ** (1 / 2.4) - 0.055)
    got = np.round(np.clip(srgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    diff = got != orig_bytes
    # Reinhard 饱和极限:srgb 字节 255(线性 1.0)经 to_hdr→HDR_MAX→from_hdr
    # 数学上不可能回到 1.0(200/201≈0.995 ⇒ 字节 254)。这是显示变换对的
    # 性质,不是 base 的钳位;除这一强制情形外仍要求**逐字节相同**。
    # 实测:崖墓原画恰 4 个 255 通道值 ⇒ 恰 4 字节差,逐一对应。
    saturated = diff & (orig_bytes == 255) & (got == 254)
    n_sat = int(saturated.sum())
    n_diff = int(diff.sum()) - n_sat
    return _res('3', 'gi=1 逐字节 ≡ 原画(255 饱和位除外)', n_diff == 0,
                f'不同字节 {n_diff}/{orig_bytes.size}'
                + (f'(另 {n_sat} 个 255 饱和位→254,Reinhard 上界的数学必然)'
                   if n_sat else ''))


# 拼接构造,免得扫描器自己的字面量被自己(与契约测试 1)扫成"泄漏"
_CRIT_NAMES = tuple('MARCH_' + s for s in ('BIAS', 'BIAS_GROWTH', 'THICKNESS')
                    ) + ('GATHER_' + 'STEP_PX',)


def check_4_single_impl() -> dict:
    pat = re.compile(r'\b(' + '|'.join(_CRIT_NAMES) + r')\b')
    offenders = []
    for py in PKG.rglob('*.py'):
        rel = py.relative_to(PKG).as_posix()
        if rel in ('trace.py', 'const.py') or rel.startswith('tests/'):
            continue
        for i, line in enumerate(py.read_text(encoding='utf-8').splitlines(), 1):
            if pat.search(line):
                offenders.append(f'{rel}:{i}')
    return _res('4', 'tracer 单一实现(判据常量静态扫描)', not offenders,
                '; '.join(offenders) or '判据常量只在 trace.py/const.py')


def check_4b_contracts() -> dict:
    """其余 6 条 tracer 契约(起点无关/单调/inf等价/解析真值/线程无关/射程=过滤)。"""
    from .tests import test_trace_contracts as t
    fns = [t.test_contract_2_batch_and_order_independence,
           t.test_contract_3_max_distance_monotone,
           t.test_contract_4_inf_equals_default,
           t.test_contract_5_analytic_plane,
           t.test_contract_6_thread_independence,
           t.test_contract_7_range_equals_filter]
    failed = []
    for fn in fns:
        try:
            fn()
        except AssertionError as exc:                     # noqa: PERF203
            failed.append(f'{fn.__name__}: {exc}')
    return _res('4b', 'tracer 契约 2–7', not failed,
                '; '.join(failed)[:400] or '6 条全绿')


def check_4c_max_distance_annotated() -> dict:
    """每个消费者的 max_distance:要么 inf,要么调用处注释说明积分为何有界。

    扫描面与 #4 同为 rglob(含 gui/,那正是不许有烘焙逻辑的地方);
    不设变量名白名单 —— 传变量的调用同样要在窗口里给理由(审查纠正)。
    """
    offenders = []
    for py in PKG.rglob('*.py'):
        rel = py.relative_to(PKG).as_posix()
        if rel in ('trace.py', 'const.py', 'check.py') or rel.startswith('tests/'):
            continue
        lines = py.read_text(encoding='utf-8').splitlines()
        for i, line in enumerate(lines):
            if 'max_distance=' not in line or 'def ' in line:
                continue
            if line.lstrip().startswith('#'):          # 注释里谈 max_distance 不算调用
                continue
            if 'math.inf' in line:
                continue
            window = '\n'.join(lines[max(0, i - 8):i + 1])
            if not any(k in window for k in ('§5.8', '问题定义', '有界', '事后过滤')):
                offenders.append(f'{rel}:{i + 1}')
    return _res('4c', '有限 max_distance 均有「为何有界」注释', not offenders,
                '; '.join(offenders) or '全部合规')


def _trilinear(vol: np.ndarray, bounds: dict, grid: dict,
               pts_world: np.ndarray) -> np.ndarray:
    nx, ny, nz = grid['nx'], grid['ny'], grid['nz']
    lo = np.array([bounds['x0'], bounds['y0'], bounds['z0']], np.float64)
    hi = np.array([bounds['x1'], bounds['y1'], bounds['z1']], np.float64)
    nn = np.array([nx, ny, nz])
    t = np.clip((pts_world - lo) / np.maximum(hi - lo, 1e-9), 0, 1) * (nn - 1)
    i0 = np.clip(np.floor(t).astype(np.int64), 0, nn - 1)
    fr = t - np.floor(t)
    i1 = np.minimum(i0 + 1, nn - 1)
    v = vol.reshape(nx, ny, nz, -1)
    out = np.zeros((len(pts_world), v.shape[-1]), np.float64)
    for bx in (0, 1):
        for by in (0, 1):
            for bz in (0, 1):
                ix = i1[:, 0] if bx else i0[:, 0]
                iy = i1[:, 1] if by else i0[:, 1]
                iz = i1[:, 2] if bz else i0[:, 2]
                wgt = ((fr[:, 0] if bx else 1 - fr[:, 0])
                       * (fr[:, 1] if by else 1 - fr[:, 1])
                       * (fr[:, 2] if bz else 1 - fr[:, 2]))
                out += wgt[:, None] * v[ix, iy, iz]
    return out


def check_5_volume_vs_surface(ctx: dict) -> dict:
    """体数据在表面 vs sky_moments 逐像素:深遮蔽偏差 ≤ 0.06(§10 #5)。"""
    inp = ctx['inp']
    vol = ctx['volume']
    a0f, a1f = ctx['moments_smooth']
    h, w = a0f.shape
    sub = (slice(None, None, 3), slice(None, None, 3))
    pw = inp.world[sub].reshape(-1, 3).astype(np.float64)
    n_scene = inp.normal[sub].reshape(-1, 3)
    v_scene = vis_of_normal(a0f[sub].ravel(), a1f[sub].reshape(-1, 3),
                            np.broadcast_to(UP, (len(pw), 3)))
    raw = vol['raw']
    tri = _trilinear(np.concatenate([raw['sky_a0'][:, None], raw['sky_a1']], 1),
                     vol['bounds'], vol['grid'], pw)
    t_vol = tri[:, 0] + tri[:, 2]                     # a0 + a1·up
    v_vol = np.clip(t_vol / 1.0, 0.0, 1.0)            # cap0(up) = 1
    dv = v_vol - v_scene.astype(np.float64)
    deep = v_scene < 0.3
    med = float(np.median(np.abs(dv)))
    p95 = float(np.percentile(np.abs(dv), 95))
    deep_bias = float(np.median(dv[deep])) if deep.sum() > 50 else 0.0
    ok = abs(deep_bias) <= 0.06
    return _res('5', '体数据在表面 vs 逐像素矩(深遮蔽偏差 ≤ 0.06)', ok,
                f'|Δ|中位 {med:.4f}  p95 {p95:.4f}  深遮蔽偏差 {deep_bias:+.4f} '
                f'(深遮蔽样本 {int(deep.sum())})')


def check_6_validity(ctx: dict) -> dict:
    v = ctx['volume']
    resid = float(v.get('residual_invalid', 0.0))
    warn = resid > 0
    r = _res('6', 'validity 覆盖率(报警阈值待定)', None,
             f"coverage={v['validity_coverage']:.3f} "
             f"dilation_iters={v['dilation_iters']} "
             f"残留无效 {resid:.4f}"
             + ('(dilation 撞迭代上限!)' if warn else ''), warn=warn)
    return r if warn else r | {'status': 'pass'}


def check_7_roundtrips(ctx: dict) -> dict:
    e, e_q = ctx['e'], ctx['e_q']
    disp_err = np.abs(e_q / (1 + e_q) - e / (1 + e)) * 255.0
    e_p99 = float(np.percentile(disp_err, 99))
    a0f, a1f = ctx['moments_smooth']
    rgba = encode_moments(a0f, a1f)
    d0, d1 = decode_moments(rgba)
    m_p99 = float(max(np.percentile(np.abs(d0 - a0f), 99),
                      np.percentile(np.abs(d1 - a1f), 99)))
    ao = ctx['ao']
    ao_q = np.round(np.clip(ao, 0, 1) * 255) / 255.0
    ao_p99 = float(np.percentile(np.abs(ao_q - ao), 99))
    # 相对域也判(§4.3「±~2% 相对」):显示域指标在 E 远离 1 时不敏感(审查)
    rel = np.abs(e_q - e) / np.maximum(e, 1e-6)
    e_rel_p99 = float(np.percentile(rel, 99))
    ok = (e_p99 <= 2.0 and e_rel_p99 <= 0.025
          and m_p99 <= 1.0 / 255 and ao_p99 <= 1.0 / 255)
    return _res('7', '三条编码曲线往返(可见量 ≤1/255,HDR 显示域 ≤2/255 且相对 ≤2.5%)',
                ok,
                f'E {e_p99:.3f}/255(rel p99 {e_rel_p99:.4f})  '
                f'矩 {m_p99 * 255:.3f}/255  AO {ao_p99 * 255:.3f}/255')


def check_8_reproducible(ctx: dict, heavy: bool) -> dict:
    """字节可复现。轻档:线程 1 vs N 重跑一段矩估计,逐位比对(每次 bake 必跑);
    重档(check 子命令):完整二次 bake,产物逐字节比对。"""
    from numba import get_num_threads, set_num_threads
    inp = ctx['inp']
    Q = inp.q.reshape(-1, 3)[::17][:8000]
    keep = get_num_threads()
    try:
        set_num_threads(1)
        a0a, a1a = sky_moments(Q, inp.R, ctx['field'], spp=8)
        set_num_threads(keep)
        a0b, a1b = sky_moments(Q, inp.R, ctx['field'], spp=8)
    finally:
        set_num_threads(keep)
    ok_light = bool(np.array_equal(a0a, a0b) and np.array_equal(a1a, a1b))
    # 「同参数两次同字节」的轻档等价物:重编码一遍 E,与产物字节逐位比
    from .encode import encode_log_hdr
    re_e8 = encode_log_hdr(ctx['e'], ctx['e_scale'], ctx['e_span'])
    ok_re = bool(np.array_equal(re_e8, ctx['e8']))
    if not heavy:
        note = '' if keep != 1 else '(⚠ --threads 1 下线程半空转)'
        return _res('8', '字节可复现(轻:线程 1 vs N 逐位 + E 重编码同字节)',
                    ok_light and ok_re,
                    f'线程无关={ok_light} 重编码={ok_re}{note}')
    from .payload import build_products
    from .pipeline import bake_scene
    params = ctx.get('bake_params') or {}
    ctx2 = bake_scene(ctx['sid'], write=False, run_checks=False,
                      make_report=False, quiet=True, **params)
    pa = ctx.get('products') or build_products(ctx)
    same = all(pa[k] == ctx2['products'][k] for k in pa)
    return _res('8', '字节可复现(重:二次 bake 产物逐字节 + 线程/重编码轻档)',
                ok_light and ok_re and same,
                f'线程无关={ok_light} 重编码={ok_re} 二次bake同字节={same}')


def check_9_gi_codec(ctx: dict) -> dict:
    v = ctx['volume']['selfcheck']['gi_codec_p99_soft_rel']
    if v is None:
        return _res('9', 'GI 通道编解码', True, '--no-gi:GI 通道按约定写零,不适用')
    return _res('9', 'GI 通道编解码(软化相对误差 p99)', v <= 0.1,
                f'p99={v:.4f}(红线 0.10)')


def check_10_sky_plain_bitwise() -> dict:
    probe = {'intensity': 1.3, 'profile': 2.0}
    a = sky_irradiance_sh(probe)
    b = sky_irradiance_sh({**probe, 'horizonGain': 0.0, 'glowGain': 0.0,
                           'groundGain': 0.0})
    ok = bool(np.array_equal(a, b))
    return _res('10', '天空 SH:三个 gain 全 0 逐位回旧路', ok,
                '逐位相同' if ok else f'最大差 {np.abs(a - b).max():.3e}')


def check_11_residual_corr(ctx: dict) -> dict:
    """base 残留相关(报警,不红):|corr| 大 = E 没除干净那一维。

    分子与**运行时真正现算的 base** 同口径:`to_hdr(原画)`(未去霾,§5.7),
    不是去霾后的 hdr_work(审查纠正:两个 base 不是同一个量)。
    depth 相关照记不设警 —— 去霾残留天然带深度相关,方案 §15 也是这么读的。
    """
    from .encode import to_hdr
    a0f, a1f = ctx['moments_smooth']
    inp = ctx['inp']
    sub = (slice(None, None, 4), slice(None, None, 4))
    il = (to_hdr(ctx['lin_raw'])[sub] @ LUMA).ravel().astype(np.float64)
    el = (ctx['e_q'][sub] @ LUMA).ravel().astype(np.float64)
    bl = np.log(np.maximum(il / np.maximum(el, 1e-6), 1e-9))
    fields = {
        'V': vis_of_normal(a0f, a1f, inp.normal)[sub].ravel(),
        'AO': ctx['ao'][sub].ravel(),
        'logE': np.log(np.maximum(el, 1e-9)),
        'depth': inp.depth[sub].ravel(),
    }
    corrs = {k: float(np.corrcoef(bl, v.astype(np.float64))[0, 1])
             for k, v in fields.items()}
    hot = {k: c for k, c in corrs.items() if abs(c) > 0.15 and k != 'depth'}
    detail = '  '.join(f'{k} {c:+.3f}' for k, c in corrs.items())
    return _res('11', 'base 残留相关(|corr|>0.15 报警)', None, detail,
                warn=bool(hot)) | ({} if hot else {'status': 'pass'})


def check_12_sky_reestimate(ctx: dict) -> dict:
    """天空重估 ≡ 全新 bake(§5.12),两半分开钉:

    (a) march 半:像素子集**重新 march**,hit_sum/esc_mask 与整场缓存的切片
        逐位相同 —— march 与天空无关、与批次无关(这是「缓存重估 = 真 bake」
        的非平凡半;旧版拿 combine 自比是同义反复,审查已纠正);
    (b) 组合半:同 cache + 另一个天空,combine 两次逐位相同(单一实现)。
    (a)+(b) ⇒ 换任意天空,重估 ≡ 用该天空全新 bake,构造性成立。
    """
    inp = ctx['inp']
    cache = ctx['cache']
    Q = inp.q.reshape(-1, 3)
    N = inp.normal.reshape(-1, 3)
    idx = np.arange(0, len(Q), 19)[:30000]
    # NEE/clamp 必须与原 bake 同配置透传:位置哈希下光源样本逐点确定,
    # 子集重 march 才与整场缓存逐位可比(配置漂了这里就该红)。
    sub = gather_scene_e(np.ascontiguousarray(Q[idx]),
                         np.ascontiguousarray(N[idx]),
                         inp.R, ctx['field'], ctx['hdr_work'], cache.spp,
                         (1, len(idx)),
                         nee_ctx=ctx.get('nee_ctx'),
                         clamp=ctx.get('clamp_indirect'))
    ok_a = (np.array_equal(sub.hit_sum, cache.hit_sum[idx])
            and np.array_equal(sub.esc_mask, cache.esc_mask[idx]))
    sky2 = make_sky_sampler({'mode': 'color', 'color': [0.5, 0.7, 1.0],
                             'intensity': 0.11}, ROOT)
    e1 = combine_e(cache, sky2)
    e2 = combine_e(cache, sky2)
    ok_b = bool(np.array_equal(e1, e2))
    return _res('12', '天空重估 ≡ 全新 bake(march 半重跑逐位 + 组合半逐位)',
                ok_a and ok_b,
                f'march半 {"逐位" if ok_a else "漂了!"}({len(idx)} 点重march)'
                f' / 组合半 {"逐位" if ok_b else "漂了!"}')


def check_13_limit_consistency(ctx: dict) -> dict:
    """极限一致性(§5.9 铁律 3)的两半:

    (a) **函数同一**:体侧通道 0 调的就是像素侧同一个 `gather.sky_moments`
        对象(`is` 断言)—— 结构保证,不是两处代码碰巧一样;
    (b) **估计器点性**:同一 float32 坐标独立成批重估计 ⇒ 与像素侧逐位相同
        (位置哈希 + 逐点归约 ⇒ 与批次/调用方无关)。
    (a)+(b) ⇒ 格点 q 与某表面点 q 逐位相等时,体值 ≡ 像素值。
    一般格点的 q 由 world 网格派生(f32 往返),与像素 q 逐位重合是测度零
    事件 —— 那时的差是三线性插值项,即 §5.9 唯一被允许的差异。
    """
    from . import volume as volume_mod
    same_fn = volume_mod.sky_moments is sky_moments
    inp = ctx['inp']
    a0_raw, a1_raw = ctx['moments_raw']
    Q = inp.q.reshape(-1, 3)
    rng = np.random.default_rng(20260823)
    idx = rng.choice(len(Q), 2000, replace=False)
    a0v, a1v = sky_moments(np.ascontiguousarray(Q[idx]), inp.R, ctx['field'],
                           spp=MOMENT_SPP)
    n_a0 = int((a0v != a0_raw.ravel()[idx]).sum())
    n_a1 = int((a1v != a1_raw.reshape(-1, 3)[idx]).any(1).sum())
    ok_b = n_a0 == 0 and n_a1 == 0
    return _res('13', '极限一致性:体侧=同一函数 + 点性逐位', same_fn and ok_b,
                f'函数同一={same_fn} / 2000 点'
                + ('逐位相同' if ok_b else f'失配 a0={n_a0} a1={n_a1}'))


# ---------------------------------------------------------------- 汇总

def run_all(ctx: dict, heavy: bool = False) -> list[dict]:
    out: list[dict] = []
    out += check_1_2_open_cells(ctx)
    out.append(check_3_gi1_identity(ctx))
    out.append(check_4_single_impl())
    out.append(check_4b_contracts())
    out.append(check_4c_max_distance_annotated())
    out.append(check_5_volume_vs_surface(ctx))
    out.append(check_6_validity(ctx))
    out.append(check_7_roundtrips(ctx))
    out.append(check_8_reproducible(ctx, heavy))
    out.append(check_9_gi_codec(ctx))
    out.append(check_10_sky_plain_bitwise())
    out.append(check_11_residual_corr(ctx))
    out.append(check_12_sky_reestimate(ctx))
    out.append(check_13_limit_consistency(ctx))
    return out


def print_table(results: list[dict], quiet: bool = False) -> None:
    if quiet:
        return
    mark = {'pass': '✓', 'warn': '⚠', 'fail': '✗'}
    ascii_mark = {'pass': '[ok]', 'warn': '[!]', 'fail': '[X]'}
    for r in results:
        line = f"  {mark[r['status']]} #{r['id']:<3} {r['name']}  —— {r['detail']}"
        try:
            print(line, flush=True)
        except UnicodeEncodeError:
            # GBK 控制台没有 ✓/⚠/✗(§14 老坑)—— 降级替换,日志不许杀 bake
            enc = sys.stdout.encoding or 'ascii'
            safe = (f"  {ascii_mark[r['status']]} #{r['id']:<3} "
                    f"{r['name']} -- {r['detail']}")
            print(safe.encode(enc, 'replace').decode(enc), flush=True)
