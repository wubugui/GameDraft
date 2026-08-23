"""自检断言（`bake` 结束必跑，红就非零退出）。

对应方案 §10 的 11 条。可离线算的（1/2/3/5/6/7/9/10/11）在 `run_checks(bundle)` 里跑；
#4（tracer 契约）与 #8（字节可复现）是 `tests/` 里的确定性测试，因为前者需要「给定
方向」、后者需要重跑一次烘焙。
"""
from __future__ import annotations

import numpy as np

from .encode import (decode_base, encode_log_hdr, pick_log_params,
                     roundtrip_log, roundtrip_visibility)
from .sky import is_plain_sky, normalized_shape, sky_irradiance_sh
from .volume import sample_transfer

_LUM = np.array([0.2126, 0.7152, 0.0722], np.float32)


class CheckResult:
    def __init__(self, cid: int, name: str, ok: bool, detail: str):
        self.cid = cid
        self.name = name
        self.ok = ok
        self.detail = detail

    def as_dict(self) -> dict:
        return {'id': self.cid, 'name': self.name, 'ok': self.ok, 'detail': self.detail}


def _check_volume_surface(bundle: dict) -> CheckResult:
    """#5 体数据（网格插值 + dilation） vs 同一点的直接 MC 参考。

    ⚠ 参考是**同一个估计量**（均匀上半球 L1 矩）的逐点 MC，不是场景侧的余弦加权 V：
    两者是不同估计量，在斜法线/遮蔽边界处天然差一截（L1 截断）。这里量的应是
    「网格 + dilation」引入的误差 —— 方案 §15 密度 3 深遮蔽偏差 +0.0555 就是它。
    """
    from .trace import trace_points
    b = bundle
    vol = b['volume']
    inp = b['inp']
    nx, ny, nz = vol['grid']['nx'], vol['grid']['ny'], vol['grid']['nz']
    stride = 4
    world = b['world'][::stride, ::stride].reshape(-1, 3)
    normal = b['normal'][::stride, ::stride].reshape(-1, 3)

    a0, a1 = sample_transfer(vol['a0'], vol['a1'], vol['bounds'], nx, ny, nz, world, 0)
    cap0 = np.maximum((1.0 + normal[:, 1]) * 0.5, 1.0 / 255.0)
    v_vol = np.clip(np.maximum(a0 + (a1 * normal).sum(-1), 0.0) / cap0, 0.0, 1.0)

    # 直接参考：同一点、同一估计量的逐点 MC（与体数据同一个 seed，spp 用 §15 密度表的 128）
    pts_q = world @ inp.R
    a0r, a1r = trace_points(pts_q, inp.R, b['depth'], inp.ppu, inp.cx, inp.cy, spp=128)
    v_ref = np.clip(np.maximum(a0r + (a1r * normal).sum(-1), 0.0) / cap0, 0.0, 1.0)

    med = float(np.median(np.abs(v_vol - v_ref)))
    deep_mask = v_ref < 0.2
    deep_bias = float(np.median(v_vol[deep_mask] - v_ref[deep_mask])) if deep_mask.any() else 0.0
    ok = med <= 0.06 and abs(deep_bias) <= 0.06
    return CheckResult(5, '体数据（网格+dilation）vs 直接 MC', ok,
                       f'偏差中位 {med:.4f}，深遮蔽偏差 {deep_bias:+.4f}（阈值 ≤0.06）'
                       f'；open_a0={vol["selfcheck"]["open_a0"]:.4f}')


def run_checks(bundle: dict) -> list[CheckResult]:
    """对一个 bundle 跑全部可离线自检。返回结果列表（含绿/红）。"""
    b = bundle
    vol = b['volume']
    sh = vol['selfcheck']
    results: list[CheckResult] = []

    # 1 无遮挡格点 a₀ = 0.5±1e-3
    a0_open = sh['open_a0']
    ok1 = abs(a0_open - 0.5) <= 1e-3
    results.append(CheckResult(1, '无遮挡格点 a₀', ok1, f'a₀={a0_open:.5f}（期望 0.5±1e-3）'))

    # 2 无遮挡格点 T(up) = 1.0±2e-3
    tup = sh['open_T_up']
    ok2 = abs(tup - 1.0) <= 2e-3
    results.append(CheckResult(2, '无遮挡格点 T(up)', ok2, f'T(up)={tup:.5f}（期望 1.0±2e-3）'))

    # 3 往返 base_q·E_q vs 原画 p99 ≤ 2/255
    p99 = b['roundtrip']['p99_255']
    results.append(CheckResult(3, '端到端往返', p99 <= 2.0,
                               f'p99={p99:.3f}/255（阈值 ≤2/255）'))

    # 5 体数据表面一致性
    results.append(_check_volume_surface(b))

    # 6 validity 覆盖率（报警阈值：< 40% 报警 —— 过半格点被埋则三线性会大面积借 0）
    cov = vol['validity_coverage']
    ok6 = cov >= 0.4
    results.append(CheckResult(6, 'validity 覆盖率', ok6,
                               f'覆盖率={cov:.1%}，dilation {vol["dilation_iters"]} 轮'
                               f'（阈值 ≥40%）'))

    # 7 三条编码曲线往返
    #   log HDR（E）：相对精度全程恒定，看相对误差 p99
    #   log（base）：字节 0 = 精确 0（设计），只在 base>0 上比相对误差
    #   线性 8-bit（可见性）：绝对误差 ≤ 1/255
    e_rt = roundtrip_log(np.abs(b['e']) + 1e-9, one_sided=False)
    base_scale, base_span = pick_log_params(b['base'], one_sided=False)
    base8 = encode_log_hdr(b['base'], base_scale, base_span)
    base_dec = decode_base(base8, base_scale, base_span)
    pos = b['base'] > 0
    base_rel = (np.abs(base_dec[pos] - b['base'][pos]) / np.maximum(b['base'][pos], 1e-9)
                if pos.any() else np.array([0.0]))
    base_p99 = float(np.percentile(base_rel, 99))
    vis_rt = roundtrip_visibility(b['vis'])
    ok7 = e_rt['p99_rel'] <= 0.05 and base_p99 <= 0.05 and vis_rt['p99_255'] <= 1.0
    results.append(CheckResult(7, '三条编码曲线往返',
                               ok7,
                               f'E p99_rel={e_rt["p99_rel"]:.4f}，base p99_rel={base_p99:.4f}，'
                               f'可见性 p99={vis_rt["p99_255"]:.3f}/255'))

    # 9 GI 通道编解码软化相对误差 p99
    gi_err = sh['gi_codec_p99_rel']
    ok9 = gi_err <= 0.05
    results.append(CheckResult(9, 'GI 通道编解码', ok9, f'软化相对误差 p99={gi_err:.4f}（阈值 ≤0.05）'))

    # 10 天空 SH：三个 gain 全 0 时与旧路逐位相同
    sky_def = {'profile': 2.0, 'intensity': 0.5, 'color': [0.7, 0.8, 1.0]}
    plain = sky_irradiance_sh(sky_def)
    shape = normalized_shape(2.0)
    rgb = np.asarray([0.7, 0.8, 1.0], np.float64)
    expect = shape[:, None] * rgb[None, :] * 0.5
    diff = float(np.abs(plain - expect).max())
    ok10 = diff <= 1e-12
    results.append(CheckResult(10, '天空 SH 旧路对齐', ok10, f'最大逐位差 {diff:.2e}'))

    # 11 base 残留相关（对 V / AO / logE 的 |corr|）
    # base 与 E 在 native 分辨率，V / AO 在 work 分辨率 ⇒ 把前者降到 work 再比
    from .encode import resize_f
    w, h = b['inp'].work
    base_lum = resize_f(b['base'] @ _LUM, (w, h)).ravel()
    logE_f = resize_f(np.log(np.maximum(b['e_native'] @ _LUM, 1e-9)), (w, h)).ravel()
    flat = base_lum
    vis_f = b['vis'].ravel()
    ao_f = b['ao'].ravel()
    corr_v = float(np.corrcoef(flat, vis_f)[0, 1]) if flat.std() > 0 else 0.0
    corr_ao = float(np.corrcoef(flat, ao_f)[0, 1]) if flat.std() > 0 else 0.0
    corr_e = float(np.corrcoef(flat, logE_f)[0, 1]) if flat.std() > 0 else 0.0
    ok11 = all(abs(c) <= 0.25 for c in (corr_v, corr_ao, corr_e))
    results.append(CheckResult(11, 'base 残留相关',
                               ok11,
                               f'corr(V)={corr_v:+.3f}，corr(AO)={corr_ao:+.3f}，'
                               f'corr(logE)={corr_e:+.3f}（阈值 |corr|≤0.25）'))
    return results


def any_failed(results: list[CheckResult]) -> bool:
    return any(not r.ok for r in results)
