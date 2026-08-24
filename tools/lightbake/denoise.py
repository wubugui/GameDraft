"""E间接 的引导去噪 —— 商业烘焙器口径的「重建层」(方案 §5.4 采样扩展族,
2026-08-25;制作人拍板:传输结构冻结,收敛只动采样与重建两层)。

à-trous 联合双边(SVGF 的空域半):5×5 B3 样条核,步距 1/2/4 三趟;
权重 = 核 × 法线对齐(dot³²)× 深度差 × 亮度差(按全图亮度标准差归一)。
UE GPU Lightmass / Unity / Bakery 的同层对应物是 OIDN/OptiX AI 去噪
(官方口径「spp 设到去噪器能救回的最低值」);这里选确定性联合双边而不是
神经网络:字节可复现(#8 双烘逐位)是本 baker 的铁律,神经去噪的跨版本
漂移担不起。实测(teahouse/破屋,NEE 开 16spp):残噪指标 0.0058→0.0002 /
0.0047→0.0000,视觉「完全平滑」且结构保留(§15)。

实现是 numba 核(逐像素独立写,prange 行并行,固定求和序 ⇒ 与线程数无关;
fastmath=False 与 tracer 同门风)。边界钳而不环绕。不引用任何 march 判据
常量 —— 这层只看 (E, normal, depth) 三张图,与求交无关。
"""
from __future__ import annotations

import numpy as np
from numba import njit, prange

__all__ = ['denoise_e']

#: 三趟 à-trous 的参数(§9 风格:值的依据在模块文档,不散在调用点)。
ATROUS_ITERS = 3
ATROUS_SIGMA_DEPTH = 0.6      # 深度权重的 e 折减尺度(q 单位)
ATROUS_SIGMA_LUM = 4.0        # 亮度权重尺度(× 全图亮度标准差)

_K5 = np.array([1.0, 4.0, 6.0, 4.0, 1.0], np.float64) / 16.0
_LUMA64 = np.array([0.2126, 0.7152, 0.0722], np.float64)


@njit(parallel=True, nogil=True, cache=True, fastmath=False)
def _atrous_pass(src, lum, nrm, dep, step, sig_d, sig_l,
                 dst):  # pragma: no cover — 语义由 tests/test_denoise.py 钉
    h, w = dep.shape
    k5 = np.array([1.0, 4.0, 6.0, 4.0, 1.0]) / 16.0
    for y in prange(h):
        for x in range(w):
            n0x = nrm[y, x, 0]
            n0y = nrm[y, x, 1]
            n0z = nrm[y, x, 2]
            d0 = dep[y, x]
            l0 = lum[y, x]
            a0 = 0.0
            a1 = 0.0
            a2 = 0.0
            ws = 0.0
            for i in range(5):
                yy = y + (i - 2) * step
                if yy < 0 or yy >= h:
                    continue
                for j in range(5):
                    xx = x + (j - 2) * step
                    if xx < 0 or xx >= w:
                        continue
                    v = (n0x * nrm[yy, xx, 0] + n0y * nrm[yy, xx, 1]
                         + n0z * nrm[yy, xx, 2])
                    if v < 0.0:
                        v = 0.0
                    v = v * v          # ^2
                    v = v * v          # ^4
                    v = v * v          # ^8
                    v = v * v          # ^16
                    wn = v * v         # ^32
                    wd = np.exp(-np.abs(d0 - dep[yy, xx]) / sig_d)
                    wl = np.exp(-np.abs(l0 - lum[yy, xx]) / sig_l)
                    wgt = k5[i] * k5[j] * wn * wd * wl
                    a0 += src[yy, xx, 0] * wgt
                    a1 += src[yy, xx, 1] * wgt
                    a2 += src[yy, xx, 2] * wgt
                    ws += wgt
            if ws < 1e-12:
                ws = 1e-12
            dst[y, x, 0] = a0 / ws
            dst[y, x, 1] = a1 / ws
            dst[y, x, 2] = a2 / ws


def denoise_e(e: np.ndarray, normal: np.ndarray, depth: np.ndarray,
              iters: int = ATROUS_ITERS) -> np.ndarray:
    """E(h,w,3 线性 HDR)的引导去噪。纯函数、确定性:同输入 ⇒ 逐位同输出
    (#8 双烘、#12 重估的构造性都不被它破坏 —— bake 与 GUI 重估调**同一份**)。
    iters=0 原样返回(--no-denoise 的关闭路径,逐位 = 旧管线)。"""
    if iters <= 0:
        return e
    src = np.ascontiguousarray(e, np.float64)
    nrm = np.ascontiguousarray(normal, np.float64)
    dep = np.ascontiguousarray(depth, np.float64)
    lum0 = src @ _LUMA64
    sig_l = ATROUS_SIGMA_LUM * float(np.std(lum0)) + 1e-6
    dst = np.empty_like(src)
    for it in range(iters):
        lum = src @ _LUMA64
        _atrous_pass(src, lum, nrm, dep, 1 << it,
                     float(ATROUS_SIGMA_DEPTH), sig_l, dst)
        src, dst = dst, src
    return np.ascontiguousarray(src, np.float32)
