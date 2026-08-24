# -*- coding: utf-8 -*-
"""tracer 的 7 条契约测试(方案 §5.4,缺一不可)。

1. 单一实现(静态扫描:判据常量只许 trace.py / const.py / tests 引用)
2. 起点无关性(同一批点与方向,批次划分/顺序不同 ⇒ 逐位相同)
3. `max_distance` 单调性
4. `max_distance = inf` 与省略参数逐位相同
5. 构造性真值(解析平面,不依赖场景数据)
6. 线程数无关(逐位)
7. 射程 = 过滤(`trace(max_distance=r)` ≡ 全程后按 `t_hit ≤ r` 收窄,逐位)
"""
from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
import pytest

from tools.lightbake.const import (GATHER_STEP_PX, MARCH_BIAS, MARCH_BIAS_GROWTH,
                                   MARCH_THICKNESS)
from tools.lightbake.trace import DepthField, TraceResult, buried, trace

PKG = Path(__file__).resolve().parents[1]


# ------------------------------------------------------------------ 公共夹具

def _rand_field(seed: int = 7, h: int = 96, w: int = 128) -> DepthField:
    rng = np.random.default_rng(seed)
    base = rng.uniform(0.5, 3.0, (h // 8, w // 8)).astype(np.float32)
    depth = np.kron(base, np.ones((8, 8), np.float32))
    return DepthField.build(depth, ppu=40.0, cx=w / 2, cy=h / 2)


def _rand_rays(field: DepthField, n: int = 4096, seed: int = 3):
    rng = np.random.default_rng(seed)
    h, w = field.depth.shape
    sx = rng.uniform(2, w - 3, n)
    sy = rng.uniform(2, h - 3, n)
    qx = (sx - field.cx) / field.ppu
    qy = (field.cy - sy) / field.ppu
    xi = np.rint(sx).astype(np.int32)
    yi = np.rint(sy).astype(np.int32)
    qz = field.depth[yi, xi] - rng.uniform(0.0, 0.4, n)      # 表面前方的空气里
    o = np.stack([qx, qy, qz], 1).astype(np.float32)
    d = rng.normal(size=(n, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    return o, d.astype(np.float32)


def _bitwise_equal(a: TraceResult, b: TraceResult) -> bool:
    return (np.array_equal(a.escaped, b.escaped)
            and np.array_equal(a.hit_yx, b.hit_yx)
            and np.array_equal(a.t_hit, b.t_hit,)
            and np.array_equal(np.isnan(a.t_hit), np.isnan(b.t_hit)))


# ------------------------------------------------------- 1. 单一实现(静态)

def test_contract_1_single_implementation():
    """判据常量只许 trace.py(实现)/ const.py(定义)/ tests 引用。

    `depth` 是共有数据,读它不禁;禁的是 trace.py 之外再写一套判据/march。
    """
    names = ('MARCH_BIAS', 'MARCH_BIAS_GROWTH', 'MARCH_THICKNESS', 'GATHER_STEP_PX')
    pat = re.compile(r'\b(' + '|'.join(names) + r')\b')
    offenders = []
    for py in PKG.rglob('*.py'):
        rel = py.relative_to(PKG).as_posix()
        if rel in ('trace.py', 'const.py') or rel.startswith('tests/'):
            continue
        for i, line in enumerate(py.read_text(encoding='utf-8').splitlines(), 1):
            if pat.search(line):
                offenders.append(f'{rel}:{i}: {line.strip()}')
    assert not offenders, '判据常量泄漏到 tracer 之外(自写判据?):\n' + '\n'.join(offenders)


# ------------------------------------------------------- 2. 起点无关性

def test_contract_2_batch_and_order_independence():
    field = _rand_field()
    o, d = _rand_rays(field)
    full = trace(o, d, field)
    # 批次划分不同
    k = len(o) // 3
    parts = [trace(o[:k], d[:k], field), trace(o[k:], d[k:], field)]
    assert np.array_equal(full.escaped, np.concatenate([parts[0].escaped, parts[1].escaped]))
    assert np.array_equal(full.t_hit, np.concatenate([parts[0].t_hit, parts[1].t_hit]))
    assert np.array_equal(full.hit_yx, np.concatenate([parts[0].hit_yx, parts[1].hit_yx]))
    # 顺序打乱:逐射线结果只跟(起点,方向)有关
    perm = np.random.default_rng(11).permutation(len(o))
    shuf = trace(o[perm], d[perm], field)
    assert np.array_equal(shuf.escaped, full.escaped[perm])
    assert np.array_equal(shuf.t_hit, full.t_hit[perm])
    assert np.array_equal(shuf.hit_yx, full.hit_yx[perm])


# ------------------------------------------------ 3. max_distance 单调性

def test_contract_3_max_distance_monotone():
    field = _rand_field()
    o, d = _rand_rays(field)
    radii = [0.1, 0.5, 1.5, 4.0, math.inf]
    prev = None
    for r in radii:
        esc = trace(o, d, field, max_distance=r).escaped
        if prev is not None:
            # r 变大,escaped 只会变少:esc(r_大) ⇒ esc(r_小)
            assert not np.any(esc & ~prev)
        prev = esc


# --------------------------------------------------- 4. inf ≡ 省略参数

def test_contract_4_inf_equals_default():
    field = _rand_field()
    o, d = _rand_rays(field, n=2048)
    assert _bitwise_equal(trace(o, d, field),
                          trace(o, d, field, max_distance=math.inf))


# ----------------------------------------------------- 5. 构造性真值

def test_contract_5_analytic_plane():
    """解析平面 depth ≡ d0,起点悬在平面前方:

    命中 ⇔ dz > MARCH_BIAS_GROWTH(pen 增速要超过 bias 增速),
    命中时刻 = 第一个 t = k·step ≥ t*,t* = (d0 − qz0 + bias)/(dz − growth)。
    d_min 直接给 0(DepthField 字段就是语义的一部分),排除终止条件 3 的干扰。
    """
    h, w = 512, 512
    d0 = 1.0
    depth = np.full((h, w), d0, np.float32)
    ppu = 64.0
    field = DepthField(depth=depth, ppu=ppu, cx=w / 2, cy=h / 2, d_min=0.0)
    step = GATHER_STEP_PX / ppu

    rng = np.random.default_rng(23)
    n = 5000
    qz0 = 0.7
    o = np.zeros((n, 3), np.float32)
    o[:, 2] = qz0
    d = rng.normal(size=(n, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    d = d.astype(np.float32)

    dz = d[:, 2].astype(np.float64)
    gap = d0 - qz0 + MARCH_BIAS
    t_star = np.where(dz > MARCH_BIAS_GROWTH, gap / np.maximum(dz - MARCH_BIAS_GROWTH, 1e-12), np.inf)
    # 边缘情形滤掉:dz 贴着 growth、或命中点已出画幅(横向跑 > 3.5 q 才出画)
    lateral = np.hypot(d[:, 0], d[:, 1]).astype(np.float64) * np.where(np.isfinite(t_star), t_star, 0)
    margin = (np.abs(dz - MARCH_BIAS_GROWTH) > 0.02) & (lateral < 3.0)
    # 前向逃逸也可留:dz ≤ growth 的射线永不命中(pen − bias 单调不升)
    res = trace(o, d, field)
    expect_hit = np.isfinite(t_star)
    got_hit = ~res.escaped
    sel = margin
    assert np.array_equal(got_hit[sel], expect_hit[sel]), (
        f'逃逸判定与解析解不一致: {np.count_nonzero(got_hit[sel] != expect_hit[sel])} 条')
    # 命中时刻:第一个跨过 t* 的整步(允许一步的量化余量)
    hit = sel & expect_hit
    t_pred = np.ceil(t_star[hit] / step) * step
    assert np.all(np.abs(res.t_hit[hit].astype(np.float64) - t_pred) < step * 1.5)
    # 无遮挡壳厚验证:pen 在命中步必须落在 (bias, THICKNESS) 里
    t_at = res.t_hit[hit].astype(np.float64)
    pen_at = qz0 + dz[hit] * t_at - d0
    assert np.all(pen_at < MARCH_THICKNESS)
    assert np.all(pen_at > MARCH_BIAS)


def test_buried_semantics():
    h, w = 32, 32
    d0 = 1.0
    depth = np.full((h, w), d0, np.float32)
    field = DepthField(depth=depth, ppu=16.0, cx=16.0, cy=16.0, d_min=0.0)
    pts = np.zeros((4, 3), np.float32)
    pts[0, 2] = d0 - 0.2                   # 空气
    pts[1, 2] = d0 + MARCH_BIAS + 0.01     # 壳内 → 埋
    pts[2, 2] = d0 + MARCH_THICKNESS + 1.0  # 深过壳 → 也埋(壳后一律实心)
    pts[3] = (100.0, 0.0, d0 + 1.0)        # 出画且深 → **不埋**(出画=逃逸同门风)
    b = buried(pts, field)
    assert list(b) == [False, True, True, False]


# ----------------------------------------------------- 6. 线程数无关

def test_contract_6_thread_independence():
    from numba import get_num_threads, set_num_threads
    field = _rand_field(seed=5)
    o, d = _rand_rays(field, n=8192, seed=9)
    keep = get_num_threads()
    try:
        set_num_threads(1)
        r1 = trace(o, d, field)
        set_num_threads(keep)
        rn = trace(o, d, field)
    finally:
        set_num_threads(keep)
    assert _bitwise_equal(r1, rn)


# ----------------------------------------------------- 7. 射程 = 过滤

def test_contract_7_range_equals_filter():
    field = _rand_field(seed=13)
    o, d = _rand_rays(field, n=4096, seed=17)
    full = trace(o, d, field)
    finite = full.t_hit[np.isfinite(full.t_hit)]
    assert finite.size > 100
    for r in (float(np.percentile(finite, 30)), float(np.percentile(finite, 70))):
        trunc = trace(o, d, field, max_distance=r)
        keep = full.t_hit <= np.float32(r)   # f32 比较 —— 核内也以 f32 收 r
        assert np.array_equal(trunc.escaped, ~keep | full.escaped)
        assert np.array_equal(trunc.t_hit, np.where(keep, full.t_hit, np.float32(np.inf)))
        assert np.array_equal(trunc.hit_yx,
                              np.where(keep[:, None], full.hit_yx, np.int32(-1)))


def test_contract_7b_f32_boundary_semantics():
    """r 恰落在某个 t_hit 的 f64 邻位:核以 **f32** 收 max_distance,
    与「事后按 f32 比较过滤」逐位一致(审查:f64 传参在这类 r 上会分叉)。"""
    field = _rand_field(seed=41)
    o, d = _rand_rays(field, n=4096, seed=43)
    full = trace(o, d, field)
    finite = full.t_hit[np.isfinite(full.t_hit)]
    t0 = np.float32(np.median(finite))
    # f64 比 t0 低一个 ULP,但 float32(r) == t0 —— 分叉高发点
    r = float(np.nextafter(np.float64(t0), 0.0))
    trunc = trace(o, d, field, max_distance=r)
    keep = full.t_hit <= np.float32(r)
    assert np.array_equal(trunc.escaped, ~keep | full.escaped)
    assert np.array_equal(trunc.t_hit,
                          np.where(keep, full.t_hit, np.float32(np.inf)))


def test_contract_5b_thickness_upper_bound():
    """MARCH_THICKNESS(壳上界)的解析真值 —— 审查反事实:把判据退化成
    `pen > bias` 的半空间测试,旧 7 条契约全绿;这条专门钉上界。

    双层场:左半近层 d=1.0、右半远层 d=5.0。起点悬在远层上方
    (qz=2.0,对远层是空气),水平朝左穿进近层区 —— 那里 pen = 1.0,
    深过壳(> 0.75)⇒ **必须不命中**、一路出画逃逸。
    再以 qz=1.5 重复:pen = 0.5 ∈ 壳 ⇒ 必须在进入近层的第一列命中。
    """
    h, w = 128, 256
    depth = np.full((h, w), 5.0, np.float32)
    depth[:, :128] = 1.0
    ppu = 32.0
    field = DepthField.build(depth, ppu=ppu, cx=128.0, cy=64.0)
    n = 64
    ys = np.linspace(-0.8, 0.8, n).astype(np.float32)
    d_left = np.tile(np.array([-1.0, 0.0, 0.0], np.float32), (n, 1))
    # 深过壳:全部逃逸
    o_deep = np.stack([np.full(n, 2.0, np.float32), ys,
                       np.full(n, 2.0, np.float32)], 1)
    r_deep = trace(o_deep, d_left, field)
    assert r_deep.escaped.all(), (
        '穿过 pen>THICKNESS 区被误判命中 —— 壳上界失效')
    # 壳内:进入近层立刻命中
    o_shell = np.stack([np.full(n, 2.0, np.float32), ys,
                        np.full(n, 1.5, np.float32)], 1)
    r_shell = trace(o_shell, d_left, field)
    assert (~r_shell.escaped).all()
    assert np.all(r_shell.hit_yx[:, 1] <= 128)
    assert np.all(r_shell.hit_yx[:, 1] >= 124)


def test_first_step_hit_from_shell_origin():
    """起点已在壳内(bias < pen₀ < THICKNESS):任意方向第一步必命中,
    `t_hit == step` 逐位(审查:此前没有任何用例的起点落在壳后)。"""
    from tools.lightbake.const import GATHER_STEP_PX
    h, w = 64, 64
    d0 = 1.0
    ppu = 32.0
    depth = np.full((h, w), d0, np.float32)
    field = DepthField.build(depth, ppu=ppu, cx=32.0, cy=32.0)
    rng = np.random.default_rng(47)
    n = 512
    o = np.zeros((n, 3), np.float32)
    o[:, 2] = d0 + 0.3                       # pen0 = 0.3 ∈ (bias, THICKNESS)
    d = rng.normal(size=(n, 3))
    d = (d / np.linalg.norm(d, axis=1, keepdims=True)).astype(np.float32)
    r = trace(o, d, field)
    step = np.float32(GATHER_STEP_PX / field.ppu)
    assert (~r.escaped).all()
    assert np.all(r.t_hit == step)


def test_degenerate_direction_rejected():
    """零方向/非单位方向直接拒绝 —— 不给 nogil 核任何挂死的机会(审查实测过)。"""
    field = _rand_field(seed=53)
    o = np.zeros((4, 3), np.float32)
    o[:, 2] = 1.0
    bad = np.zeros((4, 3), np.float32)
    with pytest.raises(ValueError, match='单位长'):
        trace(o, bad, field)
    bad2 = np.full((4, 3), 0.9, np.float32)
    with pytest.raises(ValueError, match='单位长'):
        trace(o, bad2, field)


# --------------------------------------------- 附:结果字段的完备性

def test_full_record_fields():
    field = _rand_field(seed=29)
    o, d = _rand_rays(field, n=1024, seed=31)
    r = trace(o, d, field)
    hit = ~r.escaped
    assert np.all(np.isfinite(r.t_hit[hit]))
    assert np.all(r.t_hit[r.escaped] == np.inf)
    assert np.all(r.hit_yx[hit] >= 0)
    assert np.all(r.hit_yx[r.escaped] == -1)
    h, w = field.depth.shape
    assert np.all(r.hit_yx[hit, 0] < h)
    assert np.all(r.hit_yx[hit, 1] < w)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
