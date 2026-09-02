"""逐颗 SH 去环(Sloan, Deringing Spherical Harmonics, Activision 2017)。

L2 球谐在「一侧亮一侧黑」的 probe 上负瓣很深;运行时重建按通道 `max(E,0)`
截负,红先剪到 0、绿蓝还在 → 暗区翻出翡翠/深蓝伪色;截负又发生在逐角 probe
上,负瓣区里三线性插出来的场在格边界不连续 → 网格状块。两个走样同一个根。

做法(生产标准,同 Unity 光探针的 Remove Ringing):

- 窗族 ``w_l = 1 / (1 + λ·l²(l+1)²)``(Tikhonov/拉普拉斯平方正则,
  StupidSH §窗函数;w_0 ≡ 1,DC 不动);
- 对每颗 probe 二分最小 λ,使**三个通道各自的**重建在方向采样集上都
  ``min ≥ -eps·DC``;三个通道共用这一个窗 —— 逐通道各解一个窗会引入
  新的色偏,共窗保 DC 色度逐字不变。判据用逐通道而不是亮度:亮度非负
  挡不住单通道下潜,截负照样翻色(深潭绝地实测亮度窗后伪色仍剩 2.14%,
  换逐通道判据 0.83%,亮度中位偏差不变);
- 只动负瓣超阈的 probe,干净的 probe 一个字节都不改
  (全局窗实测要吃 6~8 个点的亮度中位偏差,不干)。

方向采样集用固定 Fibonacci 球(确定性,字节可复现)。256 个方向对 L2
(最高频率 l=2)的全局最小值误差可忽略 —— 带限函数极值平缓。
"""
from __future__ import annotations

import numpy as np

from .estimators import sh_basis

__all__ = ['dering_sh', 'sh_min_dirs']

#: 负瓣判定/收敛阈:目标 min ≥ -DERING_EPS · (DC·Y00)。
DERING_EPS = 1e-3
#: 二分上界:λ=1e3 时 w1≈2.5e-4、w2≈2.8e-5,仅剩 DC(辐照度 DC 恒非负)。
_LAM_HI = 1.0e3
_BISECT_ITERS = 28
#: 求出的 λ 再放大一点点,补方向采样集夹不住的真全局最小值。
_SAFETY = 1.02

_LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def _pen_for(k: int) -> np.ndarray:
    """各系数的 l²(l+1)² 惩罚(l=0 → 0,即 w0≡1),K=9 或 25。"""
    from .estimators import lmax_of_k
    return np.array([float(l * l * (l + 1) * (l + 1))
                     for l in range(lmax_of_k(k) + 1) for _ in range(2 * l + 1)], np.float64)


def sh_min_dirs(n: int = 256) -> np.ndarray:
    """确定性 Fibonacci 球方向集 (n,3)。"""
    i = np.arange(n, dtype=np.float64) + 0.5
    phi = i * (np.pi * (3.0 - np.sqrt(5.0)))
    z = 1.0 - 2.0 * i / n
    r = np.sqrt(np.maximum(1.0 - z * z, 0.0))
    return np.stack([r * np.cos(phi), z, r * np.sin(phi)], -1).astype(np.float32)


_DIRS = sh_min_dirs(256)
_Y_CACHE: dict[int, np.ndarray] = {}


def _y_for(k: int) -> np.ndarray:
    """(256, K) 方向集上的基;按 K 缓存。"""
    if k not in _Y_CACHE:
        from .estimators import lmax_of_k
        _Y_CACHE[k] = sh_basis(_DIRS, max(2, lmax_of_k(k)))[:, :k].astype(np.float64)
    return _Y_CACHE[k]


def _wl(lam: np.ndarray, pen: np.ndarray) -> np.ndarray:
    """(S,) λ → (S,K) 各系数窗。"""
    return 1.0 / (1.0 + lam[:, None] * pen[None, :])


def _chan_min(sh64: np.ndarray, Y: np.ndarray, w: np.ndarray | None = None,
              chunk: int = 16384) -> np.ndarray:
    """(P,K,3) → (P,) 三通道重建在方向集上的最小值。分块防大场景爆内存。"""
    n = sh64.shape[0]
    out = np.empty(n, np.float64)
    for i in range(0, n, chunk):
        s = sh64[i:i + chunk]
        if w is not None:
            s = s * w[i:i + chunk, :, None]
        # (d,k)x(p,k,c) → 各通道各方向的重建值,取全局最小
        out[i:i + chunk] = np.einsum('dk,pkc->pdc', Y, s).min((1, 2))
    return out


def dering_sh(sh: np.ndarray) -> int:
    """就地去环。``sh`` (P,K,3) float32(K=9 或 25);返回被加窗的 probe 数。

    仅处理"任一通道重建最小值 < -eps·DC"的 probe;三通道共用一个窗。
    确定性纯 numpy。
    """
    K = sh.shape[1]
    if K < 9:
        raise ValueError(f'dering_sh 需要至少 L2 系数 (P,9,3),拿到 {sh.shape}')
    Y = _y_for(K)
    pen = _pen_for(K)
    shf = sh.astype(np.float64)
    dc = np.maximum(shf[:, 0, :].max(1) * float(Y[0, 0]), 0.0)   # DC 重建值
    mn = _chan_min(shf, Y)
    sel = mn < -(DERING_EPS * np.maximum(dc, 1e-12))
    if not sel.any():
        return 0
    ls = shf[sel]                                               # (S,K,3)
    tgt = -(DERING_EPS * np.maximum(dc[sel], 1e-12))
    lo = np.zeros(ls.shape[0])
    hi = np.full(ls.shape[0], _LAM_HI)
    for _ in range(_BISECT_ITERS):
        mid = 0.5 * (lo + hi)
        ok = _chan_min(ls, Y, _wl(mid, pen)) >= tgt
        hi = np.where(ok, mid, hi)
        lo = np.where(ok, lo, mid)
    w = _wl(hi * _SAFETY, pen).astype(np.float32)               # (S,K)
    sh[sel] *= w[:, :, None]
    return int(sel.sum())
