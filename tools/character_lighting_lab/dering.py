"""逐颗 SH 去环(Sloan, Deringing Spherical Harmonics, Activision 2017)。

L2 球谐在「一侧亮一侧黑」的 probe 上负瓣很深;运行时重建按通道 `max(E,0)`
截负,红先剪到 0、绿蓝还在 → 暗区翻出翡翠/深蓝伪色;截负又发生在逐角 probe
上,负瓣区里三线性插出来的场在格边界不连续 → 网格状块。两个走样同一个根。

做法(生产标准,同 Unity 光探针的 Remove Ringing):

- 窗族 ``w_l = 1 / (1 + λ·l²(l+1)²)``(Tikhonov/拉普拉斯平方正则,
  StupidSH §窗函数;w_0 ≡ 1,DC 不动);
- 对每颗 probe 的**亮度** SH 二分最小 λ,使亮度重建在方向采样集上
  ``min ≥ -eps·DC``;三个通道共用这一个窗 —— 逐通道各解一个窗会引入
  新的色偏,亮度窗保 DC 色度逐字不变;
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
#: 各系数的 l²(l+1)² 惩罚(l=0 → 0,即 w0≡1)。
_PEN = np.array([0.0] + [4.0] * 3 + [36.0] * 5, np.float64)


def sh_min_dirs(n: int = 256) -> np.ndarray:
    """确定性 Fibonacci 球方向集 (n,3)。"""
    i = np.arange(n, dtype=np.float64) + 0.5
    phi = i * (np.pi * (3.0 - np.sqrt(5.0)))
    z = 1.0 - 2.0 * i / n
    r = np.sqrt(np.maximum(1.0 - z * z, 0.0))
    return np.stack([r * np.cos(phi), z, r * np.sin(phi)], -1).astype(np.float32)


_DIRS = sh_min_dirs(256)
_Y = sh_basis(_DIRS).astype(np.float64)                     # (256, 9)


def _wl(lam: np.ndarray) -> np.ndarray:
    """(S,) λ → (S,9) 各系数窗。"""
    return 1.0 / (1.0 + lam[:, None] * _PEN[None, :])


def dering_sh(sh: np.ndarray) -> int:
    """就地去环。``sh`` (P,9,3) float32;返回被加窗的 probe 数。

    仅处理亮度重建最小值 < -eps·DC 的 probe;窗按亮度解、三通道同窗。
    确定性纯 numpy。
    """
    if sh.shape[1] < 9:
        raise ValueError(f'dering_sh 需要 L2 系数 (P,9,3),拿到 {sh.shape}')
    lum = (sh.astype(np.float64) @ _LUMA.astype(np.float64))    # (P,9)
    dc = np.maximum(lum[:, 0] * float(_Y[0, 0]), 0.0)           # DC 重建值
    mn = (lum @ _Y.T).min(1)                                    # (P,)
    sel = mn < -(DERING_EPS * np.maximum(dc, 1e-12))
    if not sel.any():
        return 0
    ls = lum[sel]                                               # (S,9)
    tgt = -(DERING_EPS * np.maximum(dc[sel], 1e-12))
    lo = np.zeros(ls.shape[0])
    hi = np.full(ls.shape[0], _LAM_HI)
    for _ in range(_BISECT_ITERS):
        mid = 0.5 * (lo + hi)
        ok = ((ls * _wl(mid)) @ _Y.T).min(1) >= tgt
        hi = np.where(ok, mid, hi)
        lo = np.where(ok, lo, mid)
    w = _wl(hi * _SAFETY).astype(np.float32)                    # (S,9)
    sh[sel] *= w[:, :, None]
    return int(sel.sum())
