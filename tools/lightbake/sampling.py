"""方向采样 —— 与 tracer 平级的独立组件(方案 §5.4「方向采样」)。

接口定死:**每个采样器返回 `(dirs, pdf)`**,估计量统一写成 `Σ f(ω)/pdf(ω) / n`。
余弦重要性下 pdf 恰好约掉、估计量 = 样本平均,只是特例。以后加分层、低差异序列、
蓝噪声、MIS,消费者一行不改。

**种子按位置哈希**:`key = hash(GATHER_SEED, q 坐标的 float32 位型)` ——
同一个空间点永远抽到同一批方向,与调用顺序、批次划分、线程数全部无关。
这是字节可复现(自检 #8)与「格点落在表面点 ⇒ 与像素侧逐位相同」(自检 #13)
共同的地基。float32 位型本身就是「量化后的坐标」:两点 float32 逐位相等
⇔ key 相等 ⇔ 方向流逐位相等,没有额外的量化参数。

采样器逐 spp 生成(内存 O(n) 而不是 O(n·spp)),`s` 是样本序号:

    for s in range(spp):
        dirs, pdf = uniform_upper_hemisphere(keys, s, spp)
        ...

每个采样器带一个固定盐(`_SALT_*`),不同采样器在同一点上流独立;
同一采样器在同一点上(不管谁调)流逐位相同 —— 极限一致性铁律 3 的实现处。
"""
from __future__ import annotations

import math

import numpy as np

from .const import GATHER_SEED

__all__ = ['point_keys', 'cosine_hemisphere', 'uniform_upper_hemisphere',
           'uniform_sphere', 'nee_uniforms']

_SALT_COSINE = np.uint64(0x9E37_0001)
_SALT_UPPER = np.uint64(0x9E37_0002)
_SALT_SPHERE = np.uint64(0x9E37_0003)
_SALT_NEE = np.uint64(0x9E37_0004)

_TWO_PI = np.float32(2.0 * math.pi)
_INV_2PI = np.float32(1.0 / (2.0 * math.pi))
_INV_4PI = np.float32(1.0 / (4.0 * math.pi))
_INV_PI = np.float32(1.0 / math.pi)


def _splitmix64(x: np.ndarray) -> np.ndarray:
    """splitmix64 的搅拌函数,矢量化 uint64(溢出回绕是刻意语义)。

    ⚠ 一律转 **≥1 维**数组再算:numpy 对标量与 0-d 数组的 uint64 溢出都发
    RuntimeWarning,1-d 数组才是静默回绕 —— 语义相同,别让告警噪音掩埋真问题。
    """
    x = np.atleast_1d(np.asarray(x, dtype=np.uint64))
    z = (x + np.uint64(0x9E3779B97F4A7C15))
    z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    return z ^ (z >> np.uint64(31))


def point_keys(pts_q: np.ndarray, seed: int = GATHER_SEED) -> np.ndarray:
    """(n,3) float32 q 坐标 → (n,) uint64 位置键。逐坐标折叠,顺序敏感。"""
    b = np.ascontiguousarray(pts_q, np.float32).view(np.uint32)
    b = b.reshape(-1, 3).astype(np.uint64)
    k = _splitmix64(np.uint64(seed) ^ b[:, 0])
    k = _splitmix64(k ^ b[:, 1])
    k = _splitmix64(k ^ b[:, 2])
    return k


def _u01(keys: np.ndarray, salt: np.uint64, ctr: int) -> np.ndarray:
    """逐点确定性均匀数 ∈ [0,1)。(key, salt, ctr) 唯一决定,与批次无关。

    ⚠ 盐先过一遍 splitmix 再加计数器:裸 `salt + ctr` 在「盐相邻 + 计数器
    步进 2」下会跨采样器撞号(upper 的 ξ₂ 流 == sphere 的 ξ₁ 流,审查用
    逐位对比证实)—— 两个通道的噪声相关,虽各自无偏但违背「流独立」承诺。
    """
    h = _splitmix64(keys ^ _splitmix64(_splitmix64(salt) + np.uint64(ctr)))
    # 高 24 位 → float32,分辨率 2⁻²⁴,MC 用足够
    return ((h >> np.uint64(40)).astype(np.float32)
            * np.float32(1.0 / 16777216.0))


def tangent_basis(normals: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """逐点切线基(世界系,法线为 +Z)。只依赖法线 —— 多 spp 的循环里
    重复算它是纯浪费(效率审查:gather 一趟白扔 ~0.75s),调用方算一次传入。"""
    N = normals
    up = np.where(np.abs(N[:, 1:2]) < 0.9,
                  np.array([[0.0, 1.0, 0.0]], np.float32),
                  np.array([[1.0, 0.0, 0.0]], np.float32))
    ta = np.cross(up, N)
    ta /= np.maximum(np.linalg.norm(ta, axis=1, keepdims=True), 1e-8)
    ta = ta.astype(np.float32)
    tb = np.cross(N, ta).astype(np.float32)
    return ta, tb


def cosine_hemisphere(normals: np.ndarray, keys: np.ndarray,
                      s: int, spp: int,
                      basis: tuple[np.ndarray, np.ndarray] | None = None,
                      ) -> tuple[np.ndarray, np.ndarray]:
    """绕 N 的余弦重要性采样。pdf = (N·ω)₊/π ⇒ 估计量 = 样本算术平均。

    u1 分层(ξ₁ 跨样本)+ 逐点抖动(§5.4)。`basis` 传 `tangent_basis(normals)`
    可免逐 spp 重算(结果逐位相同)。
    """
    N = normals
    xi1 = _u01(keys, _SALT_COSINE, 2 * s)
    xi2 = _u01(keys, _SALT_COSINE, 2 * s + 1)
    u1 = (np.float32(s) + xi1) / np.float32(spp)
    ta, tb = basis if basis is not None else tangent_basis(N)
    r = np.sqrt(u1)
    phi = _TWO_PI * xi2
    dirs = (ta * (r * np.cos(phi))[:, None]
            + tb * (r * np.sin(phi))[:, None]
            + N * np.sqrt(np.maximum(1.0 - u1, 0.0))[:, None]).astype(np.float32)
    cos = np.maximum(np.einsum('ij,ij->i', dirs, N), 0.0).astype(np.float32)
    pdf = cos * _INV_PI
    return dirs, pdf


def uniform_upper_hemisphere(keys: np.ndarray, s: int,
                             spp: int) -> tuple[np.ndarray, np.ndarray]:
    """绕 up 的均匀上半球。pdf = 1/2π。

    μ = ω·up 在 [0,1] 上均匀(dΩ = dφ·dμ ⇒ 均匀取 μ 即吸收立体角权重),
    分层 + 抖动。空间点没有法线、矩要对任意运行时法线求值,所以必须法线无关。
    """
    xi1 = _u01(keys, _SALT_UPPER, 2 * s)
    xi2 = _u01(keys, _SALT_UPPER, 2 * s + 1)
    mu = (np.float32(s) + xi1) / np.float32(spp)
    sr = np.sqrt(np.maximum(1.0 - mu * mu, 0.0))
    phi = _TWO_PI * xi2
    dirs = np.stack([sr * np.cos(phi), mu, sr * np.sin(phi)], 1).astype(np.float32)
    pdf = np.full(len(keys), _INV_2PI, np.float32)
    return dirs, pdf


def nee_uniforms(keys: np.ndarray, s: int
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """NEE 光源样本的四条均匀流(选灯 ξ、壳箱内 u、v、w)。盐独立于方向采样器
    (盐注册表在本文件,别处不许自造 —— 跨采样器流独立的承诺只此一处兑现)。"""
    return (_u01(keys, _SALT_NEE, 4 * s),
            _u01(keys, _SALT_NEE, 4 * s + 1),
            _u01(keys, _SALT_NEE, 4 * s + 2),
            _u01(keys, _SALT_NEE, 4 * s + 3))


def uniform_sphere(keys: np.ndarray, s: int,
                   spp: int) -> tuple[np.ndarray, np.ndarray]:
    """全球面均匀。pdf = 1/4π。μ ∈ [-1,1] 均匀(AO / 实体 GI:绕表面自己的
    法线积,而法线朝哪都有可能)。"""
    xi1 = _u01(keys, _SALT_SPHERE, 2 * s)
    xi2 = _u01(keys, _SALT_SPHERE, 2 * s + 1)
    mu = ((np.float32(s) + xi1) / np.float32(spp)) * np.float32(2.0) - np.float32(1.0)
    sr = np.sqrt(np.maximum(1.0 - mu * mu, 0.0))
    phi = _TWO_PI * xi2
    dirs = np.stack([sr * np.cos(phi), mu, sr * np.sin(phi)], 1).astype(np.float32)
    pdf = np.full(len(keys), _INV_4PI, np.float32)
    return dirs, pdf
