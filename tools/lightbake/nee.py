"""NEE(下一事件估计)= 第二个**方向采样器** + 立体角 MIS(方案 §5.4 预留扩展)。

伪世界的发光体 = to_hdr 展开后辐亮度超过 `NEE_EMITTER_MIN` 的画面像素
(灯笼芯/窗光,实测 ~200–1200;普通反射面 ≲1)。对每个 gather 样本追加一根
**朝发光体的方向样本**,march 打到什么就取什么的辐射 —— 可见性完全留在
被积函数里,由唯一 tracer 定义。与余弦/均匀球(BSDF)样本用 balance
heuristic 合并:同一方向上两侧权重和恒为 1,组合无偏(Veach 1995)。

## 发光元的几何 = 壳体素箱(§15 四版验尸的terminal版)

march 在 `pen ∈ (bias, thick)` 记命中 ⇒ texel 在 march 测度下的真实几何是
**像素列 × z 窗的体素箱**(`trace.SHELL_WINDOW`,壳几何唯一数据出口)。
伪世界表面全是朝观者的深度壳,表面↔表面传输以横向为主 —— 箱的侧面
就是横向命中的受光面,薄平面口径在这里天然失效(§15)。

## 测度:池化密度 = 沿射线对**所有**穿过的发光箱求和(DDA 精确弦积分)

    pdf_L(ω) = Σ_{j: 射线∩箱_j ≠ ∅} p_sel_j · (t_out³ − t_in³) / (3·V_box)

厚壳箱在射线方向上连排相交(相邻发光 texel 的箱首尾相接),单箱口径会把
密度低估「多重覆盖」倍 ⇒ f/pdf 超收(合成场实测 ×3.6,§15)。求和由
`_pdf_dda_kernel` 精确遍历像素列完成 —— 这是**采样器自己的几何**的精确
密度,不是第二套求交:march 只负责 f(命中辐射),密度只描述抽样机制。
体采样密度天生有界(近场无 1/r² 奇异),不需要 r_min 移交。

已知近似(记账):BSDF 侧只对**注册在发光像素上的命中**降权。被挡方向上
光源样本取到挡板的暗辐射(w_l·L_挡板,pl 池化后量级 ≲1e-3)会与 BSDF 的
全权暗样本轻微重复 —— 有界小偏差,能量守恒测试(8% 门)钉住它不失控。

## 事件类与缓存相容

- f = f_hit + f_sky:f_hit 两策略 MIS 分账(光源样本取 march 注册处辐射,
  逃逸 = 合法零样本);f_sky 只归 BSDF(esc_mask 原样)—— march 半与天空
  无关,§5.12 重估与 #12 结构不动。
- 随机流:位置哈希 + 独立盐(sampling._SALT_NEE,4 条流),同一空间点永远
  抽同一批光源样本 —— 字节可复现(#8)与子集重 march 逐位(#12)。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numba import njit, prange

from .const import NEE_EMITTER_MIN, NEE_MAX_EMITTERS
from .encode import LUMA
from .sampling import nee_uniforms
from .trace import SHELL_WINDOW, DepthField

__all__ = ['NeeContext', 'build_nee', 'pdf_light', 'sample_light']


@dataclass(frozen=True)
class NeeContext:
    """一张画的发光体表。构建一次,场景 gather 与体 GI 共用(辐亮度不进表:
    消费者从**自己的** hdr 数组按 march 命中像素取;p_sel 只是选取 pdf,
    尺度差不影响无偏性)。携带深度场引用 —— pdf 的 DDA 要走像素列。"""

    yx: np.ndarray         # (m,2) int32 发光 texel 像素(y,x)
    center: np.ndarray     # (m,3) f64 壳箱中心 (qx, qy, depth+窗中点)
    z0: np.ndarray         # (m,) f64 箱 z 下界 = depth + SHELL_WINDOW[0]
    z1: np.ndarray         # (m,) f64 箱 z 上界 = depth + SHELL_WINDOW[1]
    p_sel: np.ndarray      # (m,) f64 选取概率(∝ 亮度,Σ=1)
    cdf: np.ndarray        # (m,) f64
    sel_map: np.ndarray    # (h,w) int32 像素→发光体序号,非发光 = −1
    wmap: np.ndarray       # (h,w) f64 = p_sel/(3·V_box),非发光 0 —— DDA 权重图
    bbox: tuple            # (y0,y1,x0,x1) 发光像素包围盒(DDA 快拒)
    half_px: float         # 箱横向半宽(q 单位)= 0.5/ppu
    depth: np.ndarray      # (h,w) f32 深度场(与 field.depth 同一数组)
    ppu: float
    cx: float
    cy: float


def build_nee(hdr: np.ndarray, field: DepthField) -> NeeContext | None:
    """从展开后的 HDR 画面建发光体表;没有阈上发光体返回 None ——
    调用方拿 None 就走纯 BSDF 老路,逐位不变。"""
    lum = (hdr @ LUMA).astype(np.float32)
    ys, xs = np.nonzero(lum > NEE_EMITTER_MIN)
    if len(ys) == 0:
        return None
    if len(ys) > NEE_MAX_EMITTERS:
        order = np.argsort(-lum[ys, xs], kind='stable')[:NEE_MAX_EMITTERS]
        order = np.sort(order)
        ys, xs = ys[order], xs[order]
    ppu = field.ppu
    w = lum[ys, xs].astype(np.float64)
    tot = float(w.sum())
    if tot <= 0.0:
        return None
    p_sel = w / tot
    cdf = np.cumsum(p_sel)
    cdf[-1] = 1.0
    sel_map = np.full(field.depth.shape, -1, np.int32)
    sel_map[ys, xs] = np.arange(len(ys), dtype=np.int32)
    s0, s1 = SHELL_WINDOW
    dep = field.depth[ys, xs].astype(np.float64)
    half_px = 0.5 / ppu
    v_box = (2.0 * half_px) ** 2 * (s1 - s0)
    wmap = np.zeros(field.depth.shape, np.float64)
    wmap[ys, xs] = p_sel / (3.0 * v_box)
    center = np.stack([(xs - field.cx) / ppu, (field.cy - ys) / ppu,
                       dep + 0.5 * (s0 + s1)], 1).astype(np.float64)
    bbox = (int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max()))
    return NeeContext(yx=np.stack([ys, xs], 1).astype(np.int32),
                      center=center, z0=dep + s0, z1=dep + s1,
                      p_sel=p_sel, cdf=cdf, sel_map=sel_map, wmap=wmap,
                      bbox=bbox, half_px=half_px,
                      depth=field.depth, ppu=float(ppu),
                      cx=float(field.cx), cy=float(field.cy))


@njit(parallel=True, nogil=True, cache=True, fastmath=False)
def _pdf_dda_kernel(o, d, depth, wmap, s0, s1, ppu, cx, cy,
                    by0, by1, bx0, bx1, out):  # pragma: no cover — 语义由测试钉
    """沿每根射线做像素列 DDA,累加 Σ w_j·(t_out³ − t_in³)。
    这是光源**采样器几何**的精确 ω 密度,与 march 步进无关(march 只出 f)。"""
    n = o.shape[0]
    h, w = depth.shape
    for i in prange(n):
        ox = np.float64(o[i, 0])
        oy = np.float64(o[i, 1])
        oz = np.float64(o[i, 2])
        dx = np.float64(d[i, 0])
        dy = np.float64(d[i, 1])
        dz = np.float64(d[i, 2])
        sx0 = ox * ppu + cx
        sy0 = cy - oy * ppu
        vx = dx * ppu
        vy = -dy * ppu
        # 帧内 t 区间(与发光包围盒的 slab 交,快拒大多数射线)
        t_lo = 0.0
        t_hi = 1.0e30
        ok = True
        for axis in range(2):
            s = sx0 if axis == 0 else sy0
            v = vx if axis == 0 else vy
            lo_b = np.float64(bx0 if axis == 0 else by0) - 0.5
            hi_b = np.float64(bx1 if axis == 0 else by1) + 0.5
            if v > 1e-12 or v < -1e-12:
                ta = (lo_b - s) / v
                tb = (hi_b - s) / v
                if ta > tb:
                    tmp = ta
                    ta = tb
                    tb = tmp
                if ta > t_lo:
                    t_lo = ta
                if tb < t_hi:
                    t_hi = tb
            else:
                if s < lo_b or s > hi_b:
                    ok = False
        if (not ok) or t_hi <= t_lo:
            out[i] = 0.0
            continue
        acc = 0.0
        t = t_lo
        max_steps = 2 * (h + w) + 8
        for _step in range(max_steps):
            if t >= t_hi:
                break
            px = sx0 + vx * (t + 1e-9)
            py = sy0 + vy * (t + 1e-9)
            xi = np.int64(np.rint(px))
            yi = np.int64(np.rint(py))
            # 本列的离开时刻
            t_next = t_hi
            if vx > 1e-12:
                tn = ((np.float64(xi) + 0.5) - sx0) / vx
                if tn < t_next:
                    t_next = tn
            elif vx < -1e-12:
                tn = ((np.float64(xi) - 0.5) - sx0) / vx
                if tn < t_next:
                    t_next = tn
            if vy > 1e-12:
                tn = ((np.float64(yi) + 0.5) - sy0) / vy
                if tn < t_next:
                    t_next = tn
            elif vy < -1e-12:
                tn = ((np.float64(yi) - 0.5) - sy0) / vy
                if tn < t_next:
                    t_next = tn
            if 0 <= yi < h and 0 <= xi < w:
                wgt = wmap[yi, xi]
                if wgt > 0.0:
                    dep = np.float64(depth[yi, xi])
                    if dz > 1e-12:
                        ta = (dep + s0 - oz) / dz
                        tb = (dep + s1 - oz) / dz
                    elif dz < -1e-12:
                        ta = (dep + s1 - oz) / dz
                        tb = (dep + s0 - oz) / dz
                    else:
                        if dep + s0 < oz < dep + s1:
                            ta = t
                            tb = t_next
                        else:
                            ta = 1.0
                            tb = 0.0
                    a = ta if ta > t else t
                    b = tb if tb < t_next else t_next
                    if b > a:
                        acc += wgt * (b * b * b - a * a * a)
            if t_next <= t + 1e-12:
                t = t + 1e-12
            else:
                t = t_next
        out[i] = acc


def pdf_light(ctx: NeeContext, origins_q: np.ndarray,
              dirs_q: np.ndarray) -> np.ndarray:
    """光源策略在立体角测度下的**池化**密度(f64)。唯一实现 —— 光源样本的
    分母与 BSDF 命中发光体的 MIS 权都从这里拿(自身样本也经同一条路重求值,
    类边界两侧口径逐位一致)。"""
    o = np.ascontiguousarray(origins_q, np.float64)
    d = np.ascontiguousarray(dirs_q, np.float64)
    out = np.empty(len(o), np.float64)
    s0, s1 = SHELL_WINDOW
    by0, by1, bx0, bx1 = ctx.bbox
    _pdf_dda_kernel(o, d, ctx.depth, ctx.wmap,
                    np.float64(s0), np.float64(s1),
                    np.float64(ctx.ppu), np.float64(ctx.cx),
                    np.float64(ctx.cy),
                    np.int64(by0), np.int64(by1), np.int64(bx0),
                    np.int64(bx1), out)
    return out


def sample_light(ctx: NeeContext, origins_q: np.ndarray, keys: np.ndarray,
                 s: int, spp: int
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """逐点抽一根光源方向样本。返回 (e_idx, dirs_q, r, pdf_L)。

    选灯用分层流((s+ξ)/spp 扫满 CDF,分层选择 + 全局池化密度做分母仍无偏),
    壳箱内三维均匀抖动;pdf 经 `pdf_light`(DDA 池化)重求值 —— 生成机制的
    真实密度,类边界与 BSDF 侧逐位同口径。"""
    xi_pick, xi_u, xi_v, xi_w = nee_uniforms(keys, s)
    u = (np.float64(s) + xi_pick.astype(np.float64)) / np.float64(spp)
    j = np.minimum(np.searchsorted(ctx.cdf, u, side='right'),
                   len(ctx.cdf) - 1).astype(np.int64)
    target = np.empty((len(j), 3), np.float64)
    target[:, 0] = (ctx.center[j, 0]
                    + (xi_u.astype(np.float64) - 0.5) * (2.0 * ctx.half_px))
    target[:, 1] = (ctx.center[j, 1]
                    + (xi_v.astype(np.float64) - 0.5) * (2.0 * ctx.half_px))
    target[:, 2] = (ctx.z0[j]
                    + xi_w.astype(np.float64) * (ctx.z1[j] - ctx.z0[j]))
    delta = target - origins_q.astype(np.float64)
    r = np.linalg.norm(delta, axis=1)
    dirs = (delta / np.maximum(r, 1e-9)[:, None]).astype(np.float32)
    pdf = pdf_light(ctx, origins_q, dirs)
    return j, dirs, r.astype(np.float32), pdf
