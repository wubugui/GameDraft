"""à-trous 引导去噪 —— 商业烘焙器口径的「重建层」。

2026-09-01 从 `lighting-rebuild` 分支的 `tools/lightbake/denoise.py` 移植。

SVGF 的空域半:5x5 B3 样条核,步距 1/2/4 三趟;权重 = 核 x 法线对齐(dot^32)
x 深度差 x 亮度差(按全图亮度标准差归一)。UE GPU Lightmass / Unity / Bakery
的同层对应物是 OIDN/OptiX AI 去噪(官方口径「spp 设到去噪器能救回的最低值」);
这里选确定性联合双边而不是神经网络:**字节可复现**是本 baker 的铁律
(`test_烘出来的场与光照参数无关` 要求重烘两次逐字节相同),神经去噪的跨版本
漂移担不起。

实现是 numba 核(逐像素独立写,prange 行并行,固定求和序 => 与线程数无关;
fastmath=False 与 tracer 同门风)。边界**截断核并重归一**(不钳不环绕;
行随机算子 => 常数场仍精确保持)。退化法线(零/非单位)导致权重塌缩时
**回退源像素**,不许注入硬零。不引用任何 march 判据常量 —— 这层只看
(值, normal, depth) 三张图,与求交无关。

⚠ 只对 **2D 场**(逐像素 skyvis / 逐像素 E)有意义:它靠的是「法线与深度相近
的邻居应当有相近的值」这条先验,而 probe 是 3D 稀疏格点,没有屏幕空间邻域。
probe 的对应手段是 validity dilation(见 `probe_layout.dilate_invalid`)。
"""
from __future__ import annotations

import numpy as np
from numba import njit, prange

from .const import DENOISE_ITERS

__all__ = ['denoise_rgb', 'denoise_scalar', 'ATROUS_ITERS']

#: 三趟 à-trous 的参数(值的依据在模块文档,不散在调用点)。
ATROUS_ITERS = DENOISE_ITERS
ATROUS_SIGMA_DEPTH = 0.6      # 深度权重的 e 折减尺度(q 单位)
ATROUS_SIGMA_LUM = 4.0        # 亮度权重尺度(乘全图亮度标准差)

_K5 = np.array([1.0, 4.0, 6.0, 4.0, 1.0], np.float64) / 16.0
_LUMA64 = np.array([0.2126, 0.7152, 0.0722], np.float64)


@njit(parallel=True, nogil=True, cache=True, fastmath=False)
def _atrous_pass(src, lum, nrm, dep, step, sig_d, sig_l, k5,
                 dst):  # pragma: no cover — 语义由 tests/test_denoise.py 钉
    h, w = dep.shape
    nc = src.shape[2]
    for y in prange(h):
        for x in range(w):
            n0x = nrm[y, x, 0]
            n0y = nrm[y, x, 1]
            n0z = nrm[y, x, 2]
            d0 = dep[y, x]
            l0 = lum[y, x]
            acc0 = 0.0
            acc1 = 0.0
            acc2 = 0.0
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
                    acc0 += src[yy, xx, 0] * wgt
                    if nc > 1:
                        acc1 += src[yy, xx, 1] * wgt
                        acc2 += src[yy, xx, 2] * wgt
                    ws += wgt
            if ws < 1e-12:
                # 权重塌缩(退化法线等)=> 回退源像素,不许注入硬零
                for c in range(nc):
                    dst[y, x, c] = src[y, x, c]
            else:
                dst[y, x, 0] = acc0 / ws
                if nc > 1:
                    dst[y, x, 1] = acc1 / ws
                    dst[y, x, 2] = acc2 / ws


def denoise_rgb(e: np.ndarray, normal: np.ndarray, depth: np.ndarray,
                iters: int = ATROUS_ITERS) -> np.ndarray:
    """(h,w,3) 线性场的引导去噪。纯函数、确定性:同输入 => 逐位同输出。
    iters=0 原样返回(关闭路径,逐位 = 未去噪)。"""
    if iters <= 0:
        return e
    # np.array 强制拷贝:ascontiguousarray 对已是 f64 连续的输入返回**原对象**,
    # 乒乓交换后就地改写调用方数组 —— 纯函数承诺被打破
    src = np.array(e, np.float64)
    nrm = np.ascontiguousarray(normal, np.float64)
    dep = np.ascontiguousarray(depth, np.float64)
    lum0 = src @ _LUMA64
    sig_l = ATROUS_SIGMA_LUM * float(np.std(lum0)) + 1e-6
    dst = np.empty_like(src)
    for it in range(iters):
        lum = src @ _LUMA64
        _atrous_pass(src, lum, nrm, dep, 1 << it,
                     float(ATROUS_SIGMA_DEPTH), sig_l, _K5, dst)
        src, dst = dst, src
    return np.ascontiguousarray(src, np.float32)


def denoise_scalar(a: np.ndarray, normal: np.ndarray, depth: np.ndarray,
                   iters: int = ATROUS_ITERS) -> np.ndarray:
    """(h,w) 标量场的引导去噪(天穹遮蔽矩、AO 走这条)。

    引导量仍是 (normal, depth) —— 遮蔽在法线/深度不连续处本来就该不连续,
    联合双边正是为了在这些边上**不**跨越平滑(旧实现的无差别高斯会把
    墙沿的遮蔽抹到墙外去)。亮度权重用标量自身。
    """
    if iters <= 0:
        return a
    src = np.array(a, np.float64)[..., None]
    nrm = np.ascontiguousarray(normal, np.float64)
    dep = np.ascontiguousarray(depth, np.float64)
    sig_l = ATROUS_SIGMA_LUM * float(np.std(src)) + 1e-6
    dst = np.empty_like(src)
    for it in range(iters):
        lum = src[..., 0]
        _atrous_pass(src, lum, nrm, dep, 1 << it,
                     float(ATROUS_SIGMA_DEPTH), sig_l, _K5, dst)
        src, dst = dst, src
    return np.ascontiguousarray(src[..., 0], np.float32)


# ==================================================== probe 体重建层(3D)

def _sl_pair(o, n, step):
    """返回 (dst, src) 切片对:dst 区域接收来自 src(偏移 o*step)的邻居。"""
    d = o * step
    if d >= 0:
        return slice(0, n - d), slice(d, n)
    return slice(-d, n), slice(0, n + d)



def filter_probe_grid(fields: list, guide_lum, act, grid,
                      iters: int | None = None,
                      sigma_lum: float | None = None,
                      dc_var=None) -> list:
    """probe 体的重建层:3D a-trous 联合双边,SVGF 式**逐格方差**调 sigma
    (2026-09-01;lighting-rebuild 分支去噪器在 3D 网格上的对应物)。

    - 核:可分 [1,2,1]^3(27 邻域),步距 1,2,...(a-trous 翻倍);
    - 亮度权:exp(-(dL/sigma_cell)^2),sigma_cell = sigma_lum x sqrt(var~) + eps。
      var~ = 逐格 DC 方差的 3^3 valid 加权预平滑(gather 顺带累计,零额外 trace)。
      噪声大 => sigma 宽 => 亮度权趋常数,权重与取值解耦(线性平均保住无偏);
      干净 => sigma 窄 => 真边缘/真热点分毫不动。
      定 sigma 的三条死路都试过(全局线性 std / log 域全局 std / 预平滑引导):
      分别是热格撑爆 sigma 退化普通模糊(能量+8%)、含噪引导权重与噪声相关
      (能量+4~8%)、单格真热点被平均进引导(热点 50->10)。
    - **只重写有效格**;无效格不参与也不被改(其后由 dilation 填)。
    - 确定性纯 numpy,字节可复现。

    fields: [(nx,ny,nz,...) f32];guide_lum: (P,) 主 E 的 DC 亮度;
    dc_var: (P,) DC 均值方差(None = 0 => sigma 只剩 eps,滤波近似恒等)。
    """
    import numpy as np
    from .const import PROBE_FILTER_ITERS, PROBE_FILTER_SIGMA_LUM
    if iters is None:
        iters = PROBE_FILTER_ITERS
    if sigma_lum is None:
        sigma_lum = PROBE_FILTER_SIGMA_LUM
    if iters <= 0 or not act.any():
        return [np.array(x, copy=True) for x in fields]
    nx, ny, nz = grid
    K1 = (1.0, 2.0, 1.0)
    lum = np.maximum(np.asarray(guide_lum, np.float64), 0.0).reshape(nx, ny, nz)
    val = act.reshape(nx, ny, nz).astype(np.float64)
    var = (np.zeros((nx, ny, nz), np.float64) if dc_var is None
           else np.maximum(np.asarray(dc_var, np.float64), 0.0).reshape(nx, ny, nz))
    # 方差预平滑(3^3 valid 加权):SVGF 同款,免得 sigma 自己也是噪声
    vnum = np.zeros_like(var)
    vden = np.zeros((nx, ny, nz), np.float64)
    for ox in (-1, 0, 1):
        ax_d, ax_s = _sl_pair(ox, nx, 1)
        for oy in (-1, 0, 1):
            ay_d, ay_s = _sl_pair(oy, ny, 1)
            for oz in (-1, 0, 1):
                az_d, az_s = _sl_pair(oz, nz, 1)
                kk = K1[ox + 1] * K1[oy + 1] * K1[oz + 1]
                w = kk * val[ax_s, ay_s, az_s]
                vnum[ax_d, ay_d, az_d] += w * var[ax_s, ay_s, az_s]
                vden[ax_d, ay_d, az_d] += w
    var = np.where(vden > 1e-12, vnum / np.maximum(vden, 1e-12), var)
    sig = float(sigma_lum) * np.sqrt(var) + 1e-9
    out = [np.asarray(x, np.float64).reshape(nx, ny, nz, -1).copy() for x in fields]
    shapes = [x.shape for x in fields]
    for it in range(int(iters)):
        step = 1 << it
        num = [np.zeros_like(a) for a in out]
        den = np.zeros((nx, ny, nz), np.float64)
        for ox in (-1, 0, 1):
            dx_dst, dx_src = _sl_pair(ox, nx, step)
            for oy in (-1, 0, 1):
                dy_dst, dy_src = _sl_pair(oy, ny, step)
                for oz in (-1, 0, 1):
                    dz_dst, dz_src = _sl_pair(oz, nz, step)
                    kk = K1[ox + 1] * K1[oy + 1] * K1[oz + 1]
                    dl = ((lum[dx_src, dy_src, dz_src]
                           - lum[dx_dst, dy_dst, dz_dst])
                          / sig[dx_dst, dy_dst, dz_dst])
                    w = (kk * val[dx_src, dy_src, dz_src]
                         * np.exp(-dl * dl))
                    den[dx_dst, dy_dst, dz_dst] += w
                    for a, nacc in zip(out, num):
                        nacc[dx_dst, dy_dst, dz_dst] += (
                            w[..., None] * a[dx_src, dy_src, dz_src])
        ok = (den > 1e-12) & (val > 0.5)
        inv = np.where(ok, 1.0 / np.maximum(den, 1e-12), 0.0)
        for a, nacc in zip(out, num):
            a[ok] = nacc[ok] * inv[ok][..., None]
    res = []
    for a, shp in zip(out, shapes):
        res.append(a.reshape(shp).astype(np.float32))
    return res
