"""唯一 tracer —— 独立通用组件。只管求交,不管采样。

2026-09-01 从 `lighting-rebuild` 分支的 `tools/lightbake/trace.py` 移植,
判据与执行模型逐字保留;只把文档里的方案章节号换成本仓库的语境。

**铁律:本目录里任何需要「这根射线打不打得中」的地方,都必须调这里。**
不许任何消费者自己写 march 循环 —— 判据、bias、步长、出画语义只有一份。
被它替换掉的三处各写了一套(判据全不一样,漂了几个月没人发现):

| 旧实现 | 步长 | 射程 | thickness | 症状 |
|---|---|---|---|---|
| `scene_geometry.march_blocked`(逐像素天穹) | 2.2/16 wu ≈ 15.5 px | 2.2 wu | 2.0 wu | 细结构不挡光、半个画幅外不挡光 |
| `scene_fields._march_blocked_from`(3D 网格) | 2.2/16 wu | 2.2 wu | 2.0 wu | 同上 |
| `pipeline._trace`(probe 体素 DDA) | 0.9 体素 | 220 步 | 体素占据 | round() 采样跳过 1 体素薄墙 |

## 语义规格

    step = GATHER_STEP_PX / ppu
    t = 0
    loop:
        t += step
        q(t) = o + d*t ;  sx = qx*ppu + cx ;  sy = cy - qy*ppu
        if sx 出界 or sy 出界
           or qz <= d_min - 1e-3
           or qz >= d_max + THICKNESS + 1e-3:           -> 逃逸(终止 2/3/4)
        xi = rint(sx) ;  yi = rint(sy)
        pen  = qz - depth[yi, xi]
        bias = MARCH_BIAS + MARCH_BIAS_GROWTH*t
        if bias < pen < MARCH_THICKNESS:        -> 命中,带回 (yi, xi, t)

出画就是逃逸,零自由参数。三个终止条件全精确 —— 没有「跑 N 步就停」这种
拍脑袋的截断(旧实现 16 步 / 220 步都是)。

## 执行模型

逐射线编译核 + prange 多线程(pbrt/Embree 的共同结构):一线程领一段射线的完整
生命周期,只读场景、只写自己那段结果,零共享写。核只出 `escaped/hit_yx/t_hit`,
**任何归约都不进核**(归约留 numpy 主线程按固定顺序做 => 产物逐位与线程数无关)。
`fastmath=False` 钉死(FMA/重排会破字节可复现 —— `test_烘出来的场与光照参数无关`
要求重烘两次逐字节相同)。

**没有降级路径**:numba 导入失败 => 报错退出,错误信息给出离线安装命令。
一个静默退化成纯 numpy 的慢路只会让人以为「烘了」,实际烘了半天没烘完。

## 没有射程参数(制作人 2026-09-01 铁令)

`trace()` **不接受**任何射程/步数上限。想问「r 之内被挡了没」就对返回的
`t_hit` 做事后过滤 —— 全记录本来就带着它,一次 trace 什么都能问,
而且过滤是调用方自己写的、看得见的,不会伪装成 tracer 的固有性质。

把截断做进 tracer 的代价是它会**静默地编造遮蔽**:旧实现射程 2.2 wu、
场景宽 4.5 wu,街对面整排房子一根射线都挡不住,画面上只是"有点太亮"。

"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .const import (GATHER_SEED, GATHER_STEP_PX, MARCH_BIAS, MARCH_BIAS_GROWTH,
                    MARCH_THICKNESS)

_NUMBA_INSTALL_HINT = (
    'tools/character_lighting_lab 的 tracer 需要 numba 编译核,当前环境导入失败。\n'
    '离线安装(wheelhouse 已含 cp311 win_amd64 轮子):\n'
    '  sh scripts/py.sh -m pip install --no-index '
    '--find-links .tools/wheelhouse_py311 numba==0.67.0 llvmlite==0.49.0\n'
    '没有降级路径:修环境,不要绕过。'
)

try:
    from numba import njit, prange, set_num_threads  # noqa: F401
except Exception as _exc:  # noqa: BLE001 — 统一转成带修复命令的硬错误
    raise ImportError(_NUMBA_INSTALL_HINT) from _exc


#: 可见壳的命中 z 窗(相对像素深度的 (下界, 上界))。壳几何的唯一出口。
SHELL_WINDOW = (float(MARCH_BIAS), float(MARCH_THICKNESS))


@dataclass(frozen=True)
class DepthField:
    """被追踪的那个场。一次构造、到处复用,不许每个消费者自己拼。

    与 `scene_geometry.Scene.geometry()` 的口径一致:q 空间深度、
    工作分辨率下的等效标定(ppu/cx/cy 已按横向缩放)。
    """

    depth: np.ndarray        # (h,w) float32 连续,q 空间深度
    ppu: float
    cx: float
    cy: float
    d_min: float             # depth.min(),终止条件 3 用
    #: depth.max()。终止条件 4(后穿):qz >= d_max + THICKNESS 之后
    #: pen > THICKNESS 对任何像素恒成立、永不可能再命中 —— 精确终止,
    #: 与前穿对称。没有它,dz=+1 的射线在数学上永不终止(核静默挂死)。
    d_max: float = math.inf

    @classmethod
    def build(cls, depth: np.ndarray, ppu: float, cx: float, cy: float) -> 'DepthField':
        d = np.ascontiguousarray(depth, np.float32)
        return cls(depth=d, ppu=float(ppu), cx=float(cx), cy=float(cy),
                   d_min=float(d.min()), d_max=float(d.max()))

    @classmethod
    def from_geo(cls, geo: dict) -> 'DepthField':
        """从 `Scene.geometry(size)` 的返回值直接构造 —— 标定只有一处口径。"""
        return cls.build(geo['depth'], geo['ppu'], geo['cx'], geo['cy'])


@dataclass
class TraceResult:
    """全记录,永远带满(12 B/射线)—— 一次 trace 带回任何想要的数据。

    - 命中处要什么值(辐射/深度/法线)= 拿 `hit_yx` 索引一次,永不重跑 march;
    - 任何射程的判定 = 对 `t_hit` 的事后过滤:r 内被挡 等价于 t_hit <= r。
    """

    escaped: np.ndarray      # (n,) bool —— True = 一路跑出去了
    hit_yx: np.ndarray       # (n,2) int32,命中像素(逃逸射线为 -1)
    t_hit: np.ndarray        # (n,) float32,命中处行进距离(逃逸为 +inf)


@njit(parallel=True, nogil=True, cache=True, fastmath=False)
def _march_kernel(perm, o, d, depth, ppu, cx, cy,
                  step, bias0, grow, thickness, d_min_lim, d_max_lim,
                  escaped, hit_y, hit_x, t_hit):  # pragma: no cover — 语义由契约测试钉
    n = o.shape[0]
    h, w = depth.shape
    w_lim = np.float32(w - 1)
    h_lim = np.float32(h - 1)
    for i in prange(n):
        j = perm[i]          # 调度置换只做下标间接:零拷贝、零逆置换,结果逐位不变
        oxi = o[j, 0]
        oyi = o[j, 1]
        ozi = o[j, 2]
        dxi = d[j, 0]
        dyi = d[j, 1]
        dzi = d[j, 2]
        t = np.float32(0.0)
        esc = True
        hy = np.int32(-1)
        hx = np.int32(-1)
        th = np.float32(np.inf)
        while True:
            t = t + step
            qz = ozi + dzi * t
            sx = (oxi + dxi * t) * ppu + cx
            sy = cy - (oyi + dyi * t) * ppu
            if sx < np.float32(0.0) or sx >= w_lim \
                    or sy < np.float32(0.0) or sy >= h_lim \
                    or qz <= d_min_lim or qz >= d_max_lim:
                break            # 终止 2/3/4:出画 / 前穿 / 后穿(全精确)
            xi = np.int32(np.rint(sx))
            yi = np.int32(np.rint(sy))
            pen = qz - depth[yi, xi]
            bias = bias0 + grow * t
            if pen > bias and pen < thickness:
                esc = False                              # 终止 1:命中
                hy = yi
                hx = xi
                th = t
                break
        escaped[j] = esc
        hit_y[j] = hy
        hit_x[j] = hx
        t_hit[j] = th


@lru_cache(maxsize=8)
def _schedule_perm(n: int) -> np.ndarray:
    """负载均衡用的固定置换:种子只由 GATHER_SEED 与 n 派生,与调用内容无关。

    规则网格下标连续 = 空间连续 = 命中代价强相关(壳内格点一步命中,
    深埋/开埋格点各有长尾),prange 静态分块会切出整段冷热不均的线程。
    置换以**下标间接**方式进核(物化 o[perm] + 逆置换的拷贝开销比核本身还贵),
    只改调度不改任何结果。返回数组置只读:核只拿它当索引,谁原地改了它,
    核就会静默漏写结果槽。
    """
    rng = np.random.default_rng([GATHER_SEED, n])
    p = rng.permutation(n)
    p.flags.writeable = False
    return p


def trace(origins_q: np.ndarray, dirs_q: np.ndarray,
          field: DepthField) -> TraceResult:
    """一批射线的求交。(n,3) q 空间起点 + (n,3) 单位方向(q 空间)。

    **射线一律无限长。** 没有射程参数、没有步数上限、没有任何形式的钳制
    (制作人 2026-09-01 铁令)。终止只有三条,而且全是精确的几何判据:
    出画 / 前穿 / 后穿。

    世界方向转 q:`dirs_world @ R`(R 正交 => 转置即逆,与 `Scene.geometry`
    的 `world = R @ q` 反向)。

    ⚠ 前置条件:终止 3/4 是**瞬时**判据,不看方向 —— 起点 qz 已在
    (d_min-1e-3, d_max+THICKNESS+1e-3) 之外的射线第一步即按逃逸收工,
    即使它朝着场景走。生产调用方天然满足(表面点 qz 在 [d_min,d_max];
    体侧被埋格已剔除、开阔格与场景同带)。从带外起点发射是未定义用法。
    """
    o = np.ascontiguousarray(origins_q, np.float32)
    d = np.ascontiguousarray(dirs_q, np.float32)
    n = len(o)
    if n == 0:
        return TraceResult(np.zeros(0, np.bool_),
                           np.full((0, 2), -1, np.int32),
                           np.zeros(0, np.float32))
    # t 的量纲建立在单位方向上;(0,0,0) 这类退化方向
    # 还会让核永不终止 —— 入口一次性挡掉。
    ln2 = np.einsum('ij,ij->i', d, d)
    if bool((np.abs(ln2 - 1.0) > 3e-3).any()):
        raise ValueError('trace(): dirs_q 必须单位长(含禁止零方向)')
    perm = _schedule_perm(n)
    escaped = np.empty(n, np.bool_)
    hit_y = np.empty(n, np.int32)
    hit_x = np.empty(n, np.int32)
    t_hit = np.empty(n, np.float32)
    _march_kernel(perm, o, d, field.depth,
                  np.float32(field.ppu), np.float32(field.cx), np.float32(field.cy),
                  np.float32(GATHER_STEP_PX / field.ppu),
                  np.float32(MARCH_BIAS), np.float32(MARCH_BIAS_GROWTH),
                  np.float32(MARCH_THICKNESS),
                  np.float32(field.d_min - 1e-3),
                  np.float32(field.d_max) + np.float32(MARCH_THICKNESS)
                  + np.float32(1e-3),
                  escaped, hit_y, hit_x, t_hit)
    return TraceResult(escaped, np.stack([hit_y, hit_x], 1), t_hit)


def buried(pts_q: np.ndarray, field: DepthField) -> np.ndarray:
    """(n,) bool:点是否埋在可见壳后面(帧内且 pen0 > MARCH_BIAS)。

    「埋没」是 t=0 处的壳入口判定,属于 tracer;probe 的 validity 从这里拿,
    消费者不许自己算 pen。**出画的点不算埋** —— 与「出画就是逃逸」同一门风
    (用 clip 拿边缘像素判会让同一个出画点 buried() 说埋、trace() 第一步却逃逸,
    判据自相矛盾)。
    """
    p = np.ascontiguousarray(pts_q, np.float32)
    h, w = field.depth.shape
    sx = p[:, 0] * np.float32(field.ppu) + np.float32(field.cx)
    sy = np.float32(field.cy) - p[:, 1] * np.float32(field.ppu)
    inside = (sx >= 0) & (sx < w - 1) & (sy >= 0) & (sy < h - 1)
    xi = np.clip(np.rint(sx), 0, w - 1).astype(np.int32)
    yi = np.clip(np.rint(sy), 0, h - 1).astype(np.int32)
    pen0 = p[:, 2] - field.depth[yi, xi]
    return inside & (pen0 > np.float32(MARCH_BIAS))


def set_threads(n: int) -> None:
    """线程数全局设一次(0 = 全部逻辑核)。并行是 trace.py 的内部实现细节:
    `trace()` 签名不变,产物与线程数无关。"""
    if n and n > 0:
        set_num_threads(n)
