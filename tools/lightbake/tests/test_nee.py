# -*- coding: utf-8 -*-
"""NEE+MIS 与 clamp(§5.4 采样扩展)的等价性 / 无偏性 / 确定性。

- 关(nee_ctx=None, clamp=None)⇒ 与旧累积回路**逐位**相同;
- 开 ⇒ 总能量与纯 BSDF 高 spp 参考一致(无偏),同 spp 下 firefly 尾部塌掉;
- 位置哈希 ⇒ 子集重 march 与整场逐位一致(自检 #12 依赖的机制);
- clamp:天高的钳 = 不钳(×1.0 逐位),有效钳单调压能量、保色度。
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from tools.lightbake.encode import LUMA
from tools.lightbake.gather import clamp_rows, gather_scene_e
from tools.lightbake.nee import build_nee, pdf_light
from tools.lightbake.sampling import cosine_hemisphere, point_keys, tangent_basis
from tools.lightbake.trace import DepthField, trace
from tools.lightbake.volume import bake_volume

R_ID = np.eye(3, dtype=np.float32)


# ------------------------------------------------------------------ 公共夹具

def _blocky_field(seed: int = 7, h: int = 96, w: int = 128,
                  ppu: float = 40.0) -> DepthField:
    """块状随机深度:块间断崖 = 墙,发光块对大量接收点可见。"""
    rng = np.random.default_rng(seed)
    base = rng.uniform(0.5, 3.0, (h // 8, w // 8)).astype(np.float32)
    depth = np.kron(base, np.ones((8, 8), np.float32))
    return DepthField.build(depth, ppu=ppu, cx=w / 2, cy=h / 2)


def _receivers(field: DepthField, n: int = 1200, seed: int = 3):
    rng = np.random.default_rng(seed)
    h, w = field.depth.shape
    sx = rng.uniform(2, w - 3, n)
    sy = rng.uniform(2, h - 3, n)
    qx = (sx - field.cx) / field.ppu
    qy = (field.cy - sy) / field.ppu
    xi = np.rint(sx).astype(np.int32)
    yi = np.rint(sy).astype(np.int32)
    qz = field.depth[yi, xi] - rng.uniform(0.05, 0.4, n)   # 表面前方空气里
    q = np.stack([qx, qy, qz], 1).astype(np.float32)
    nrm = rng.normal(size=(n, 3))
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    return np.ascontiguousarray(q), np.ascontiguousarray(nrm.astype(np.float32))


def _rim_field(h: int, w: int, ppu: float = 40.0, z_far: float = 10.0,
               z_near: float = 5.0, rim: int = 6) -> DepthField:
    """开阔平面 + 近沿边框:把深度带撑到 [z_near, z_far],让悬在平面前方的
    接收点/格点落在带内(平坦场 d_min = z_far,带外起点第一步就按前穿逃逸 ——
    trace() 文档写明的未定义用法,首版正面测试就是栽在这,两边全零假红)。"""
    depth = np.full((h, w), z_far, np.float32)
    depth[:rim, :] = z_near
    depth[-rim:, :] = z_near
    depth[:, :rim] = z_near
    depth[:, -rim:] = z_near
    return DepthField.build(depth, ppu=ppu, cx=w / 2, cy=h / 2)


def _hdr_with_emitters(field: DepthField, seed: int = 5,
                       block: tuple[int, int, int] = (40, 60, 6)) -> np.ndarray:
    rng = np.random.default_rng(seed)
    h, w = field.depth.shape
    hdr = rng.uniform(0.02, 0.08, (h, w, 3)).astype(np.float32)
    y0, x0, k = block
    hdr[y0:y0 + k, x0:x0 + k] = 180.0
    return hdr


# --------------------------------------------------- 关闭路径 = 旧路(逐位)

def test_nee_off_bitwise_equals_legacy_loop():
    """nee_ctx=None、clamp=None 时,新累积(contrib 数组)与旧回路
    `hit_sum[hit] += hdr[yx]` 逐位相同(+0.0 与逐行赋值都不动位型)。"""
    field = _blocky_field()
    q, nrm = _receivers(field, n=400)
    hdr = _hdr_with_emitters(field)
    spp = 8
    cache = gather_scene_e(q, nrm, R_ID, field, hdr, spp, (1, len(q)))
    keys = point_keys(q)
    basis = tangent_basis(nrm)
    hit_sum = np.zeros((len(q), 3), np.float64)
    esc = np.empty((len(q), spp), np.bool_)
    for s in range(spp):
        dirs, _pdf = cosine_hemisphere(nrm, keys, s, spp, basis=basis)
        res = trace(q, dirs @ R_ID, field, max_distance=math.inf)
        esc[:, s] = res.escaped
        hit = ~res.escaped
        hit_sum[hit] += hdr[res.hit_yx[hit, 0], res.hit_yx[hit, 1]]
    assert np.array_equal(cache.hit_sum, hit_sum)
    assert np.array_equal(cache.esc_mask, esc)


def test_build_nee_none_without_emitters():
    field = _blocky_field()
    hdr = np.full((*field.depth.shape, 3), 0.05, np.float32)
    assert build_nee(hdr, field) is None


# ------------------------------------------------------- 无偏性 + 灭 firefly

def test_nee_unbiased_and_kills_fireflies():
    """参考 = NEE 512 spp(光源样本让参考自身低方差)。
    (a) 纯 BSDF 2048 spp 的总能量与参考一致 ⇒ NEE 没有改被估的积分;
    (b) 同 64 spp 下,对参考的 p99 偏差 NEE 至少砍半 ⇒ firefly 尾部塌掉。"""
    field = _blocky_field()
    q, nrm = _receivers(field, n=900, seed=11)
    hdr = _hdr_with_emitters(field)
    ctx = build_nee(hdr, field)
    assert ctx is not None and len(ctx.yx) == 36
    ref = gather_scene_e(q, nrm, R_ID, field, hdr, 512, (1, len(q)),
                         nee_ctx=ctx)
    e_ref = (ref.hit_sum / 512) @ LUMA
    off_hi = gather_scene_e(q, nrm, R_ID, field, hdr, 2048, (1, len(q)))
    e_off_hi = (off_hi.hit_sum / 2048) @ LUMA
    rel = abs(float(e_off_hi.mean() - e_ref.mean())) / max(float(e_ref.mean()),
                                                           1e-9)
    assert rel < 0.08, f'NEE 口径与纯 BSDF 口径总能量漂了 {rel:.1%}'
    # firefly 断言另起正面几何(见 test_nee_kills_fireflies_frontal):
    # 块状场的接收点贴着各自平面悬浮,看发光块几乎全是掠射(dz→0,
    # 穿越点在方格外)—— 那是设计上归 BSDF 的类,NEE 本就不主张覆盖。
    # 这里只钉能量守恒。


def test_nee_kills_fireflies_frontal():
    """NEE 主张的类:发光面被**正面**看到(真实画里的灯笼/窗光)。
    开阔平面 + 发光块,接收点悬在正上方 —— 同 spp 下 p99 偏差至少砍半。"""
    field = _rim_field(96, 128)
    rng = np.random.default_rng(21)
    hdr = rng.uniform(0.02, 0.08, (96, 128, 3)).astype(np.float32)
    hdr[44:50, 60:66] = 180.0
    ctx = build_nee(hdr, field)
    assert ctx is not None
    n = 600
    q = np.stack([rng.uniform(-1.2, 1.2, n), rng.uniform(-0.9, 0.9, n),
                  10.0 - rng.uniform(1.0, 3.0, n)], 1).astype(np.float32)
    nrm = rng.normal(size=(n, 3))
    nrm[:, 2] = np.abs(nrm[:, 2])            # 朝向平面(+z),保证有正对分量
    nrm = (nrm / np.linalg.norm(nrm, axis=1, keepdims=True)).astype(np.float32)
    q = np.ascontiguousarray(q)
    nrm = np.ascontiguousarray(nrm)
    ref = gather_scene_e(q, nrm, R_ID, field, hdr, 512, (1, n), nee_ctx=ctx)
    e_ref = (ref.hit_sum / 512) @ LUMA
    on = gather_scene_e(q, nrm, R_ID, field, hdr, 64, (1, n), nee_ctx=ctx)
    off = gather_scene_e(q, nrm, R_ID, field, hdr, 64, (1, n))
    d_on = np.abs((on.hit_sum / 64) @ LUMA - e_ref)
    d_off = np.abs((off.hit_sum / 64) @ LUMA - e_ref)
    assert (np.percentile(d_off, 99)
            > 2.0 * np.percentile(d_on, 99)), 'NEE 没把 firefly 尾部压下来'
    # 能量也要守恒(正面几何下光源类占大头,最灵敏)
    off_hi = gather_scene_e(q, nrm, R_ID, field, hdr, 2048, (1, n))
    m_ref = float(((ref.hit_sum / 512) @ LUMA).mean())
    m_off = float(((off_hi.hit_sum / 2048) @ LUMA).mean())
    assert abs(m_off - m_ref) / max(m_ref, 1e-9) < 0.08


# ------------------------------------------------------------------- clamp

def test_clamp_semantics():
    field = _blocky_field()
    q, nrm = _receivers(field, n=300, seed=2)
    hdr = _hdr_with_emitters(field)
    a = gather_scene_e(q, nrm, R_ID, field, hdr, 16, (1, len(q)))
    b = gather_scene_e(q, nrm, R_ID, field, hdr, 16, (1, len(q)), clamp=1e12)
    assert np.array_equal(a.hit_sum, b.hit_sum)     # 天高的钳 = 不钳(逐位)
    c = gather_scene_e(q, nrm, R_ID, field, hdr, 16, (1, len(q)), clamp=0.5)
    lum_a = a.hit_sum @ LUMA
    lum_c = c.hit_sum @ LUMA
    assert np.all(lum_c <= lum_a + 1e-9)
    # 每样本亮度 ≤ clamp ⇒ 和 ≤ clamp·spp(BSDF 单策略,光源样本此处未开)
    assert np.all(lum_c <= 0.5 * 16 + 1e-6)


def test_clamp_rows_unit():
    rows = np.array([[4.0, 2.0, 2.0], [0.01, 0.0, 0.0]])
    out = clamp_rows(rows.copy(), 1.0)
    l0 = float(rows[0] @ LUMA.astype(np.float64))
    assert l0 > 1.0
    assert np.allclose(out[0], rows[0] / l0, rtol=1e-12)   # 等比缩,保色度
    assert np.allclose(out[0] @ LUMA.astype(np.float64), 1.0, rtol=1e-12)
    assert np.allclose(out[1], rows[1])                    # 阈下行原样
    same = clamp_rows(rows, None)
    assert same is rows                                    # 关闭 = 原对象


# --------------------------------------------- 子集重 march 逐位(#12 的机制)

def test_nee_subset_remarch_bitwise():
    field = _blocky_field()
    q, nrm = _receivers(field, n=500, seed=9)
    hdr = _hdr_with_emitters(field)
    ctx = build_nee(hdr, field)
    full = gather_scene_e(q, nrm, R_ID, field, hdr, 16, (1, len(q)),
                          nee_ctx=ctx, clamp=2.0)
    idx = np.arange(0, len(q), 7)
    sub = gather_scene_e(np.ascontiguousarray(q[idx]),
                         np.ascontiguousarray(nrm[idx]),
                         R_ID, field, hdr, 16, (1, len(idx)),
                         nee_ctx=ctx, clamp=2.0)
    assert np.array_equal(sub.hit_sum, full.hit_sum[idx])
    assert np.array_equal(sub.esc_mask, full.esc_mask[idx])


# ------------------------------------------------------------ pdf 的近场移交

def test_pdf_light_nearfield_and_support():
    field = _blocky_field()
    hdr = _hdr_with_emitters(field)
    ctx = build_nee(hdr, field)
    d_down = np.array([[0.0, 0.0, 1.0]], np.float32)   # 正对壳箱顶面

    def origin_from_center(dist):
        o = ctx.center[0].copy()
        o[2] -= dist                            # 沿 −z 从箱心退开 dist
        return np.array([o], np.float32)

    far = pdf_light(ctx, origin_from_center(1.0), d_down)
    assert far[0] > 0.0
    # 支撑:射线整条错过所有箱(横向偏出发光块、方向平行 z)⇒ 密度 0 ⇒ 权重 1
    o_side = origin_from_center(1.0)
    o_side[0, 0] += 30.0 * ctx.half_px
    assert pdf_light(ctx, o_side, d_down)[0] == 0.0
    # 横向射线穿箱侧面 ⇒ 密度 > 0(伪世界表面间传输的主体类,薄平面口径的死穴)
    o_lat = ctx.center[0].copy()
    o_lat[0] -= 1.0
    d_lat = np.array([[1.0, 0.0, 0.0]], np.float32)
    assert pdf_light(ctx, np.array([o_lat], np.float32), d_lat)[0] > 0.0
    # 池化:同一射线穿过发光块的多个连排箱,密度 ≥ 单箱(多重覆盖必须求和 ——
    # 单箱口径实测超收 ×3.6,§15)
    # 自身样本经同一函数求值 ⇒ 恒 > 0(类边界两侧同口径)
    from tools.lightbake.sampling import point_keys as pk
    o = origin_from_center(1.0)
    from tools.lightbake.nee import sample_light
    _j, _d, _r, pl = sample_light(ctx, o, pk(o), 0, 4)
    assert pl[0] > 0.0


# --------------------------------------------------------------- 体 GI 一致性

def test_volume_gi_nee_energy_consistent():
    """体 GI 的 NEE 口径与纯 BSDF 高 spp 口径能量一致(活格上 gi_a₀ 均值)。

    用**正面几何**(开阔平面 + 发光块,格点悬在上方):光源类占发光能量大头,
    能量门才有检验力。块状场是病理配置 —— 发光块几乎只被掠射看到(A_out
    占 91.5%,守恒式诊断 2026-08-25),那个火花重尾通道在 64 spp 下的单次
    实现噪声就有 ±16%,盖过被测量;其守恒已由场景侧压力测试 + 诊断钉住。"""
    field = _rim_field(64, 96)
    rng = np.random.default_rng(31)
    hdr = rng.uniform(0.02, 0.08, (64, 96, 3)).astype(np.float32)
    hdr[28:34, 44:50] = 180.0
    h, w = field.depth.shape
    ys, xs = np.mgrid[0:h, 0:w]
    world = np.stack([(xs - field.cx) / field.ppu,
                      (field.cy - ys) / field.ppu,
                      field.depth], -1).astype(np.float32)
    ctx = build_nee(hdr, field)
    assert ctx is not None

    def sky0(dw):
        return np.zeros((np.atleast_2d(np.asarray(dw)).shape[0], 3), np.float32)

    on = bake_volume(world, R_ID, field, hdr, sky0, 0.6, 0.3, spp=64,
                     nee_ctx=ctx)
    off = bake_volume(world, R_ID, field, hdr, sky0, 0.6, 0.3, spp=1024)
    act = ~on['raw']['invalid']
    g_on = float(on['raw']['gi_a0'][act].mean())
    g_off = float(off['raw']['gi_a0'][act].mean())
    assert abs(g_on - g_off) / max(g_off, 1e-9) < 0.08, (
        f'体 GI 能量漂了:nee {g_on:.4f} vs bsdf {g_off:.4f}')


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
