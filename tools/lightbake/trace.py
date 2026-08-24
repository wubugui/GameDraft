"""唯一 tracer —— 独立通用组件(方案 §5.4)。只管求交,不管采样。

铁律:本 baker 里任何需要「这根射线打不打得中」的地方,都必须调这里。
不许任何消费者自己写 march 循环 —— 判据、bias、步长、出画语义只有一份。

## 语义规格(与 §5.4 伪代码逐字对齐;解析真值由契约测试 5 钉住)

    step = GATHER_STEP_PX / ppu
    t = 0
    loop:
        t += step
        q(t) = o + d·t ;  sx = qx·ppu + cx ;  sy = cy − qy·ppu
        if sx ∉ [0, w-1) or sy ∉ [0, h-1)
           or qz ≤ d_min − 1e-3
           or qz ≥ d_max + THICKNESS + 1e-3:            → 逃逸(终止 2/3/4)
        xi = rint(sx) ;  yi = rint(sy)
        pen  = qz − depth[yi, xi]
        bias = MARCH_BIAS + MARCH_BIAS_GROWTH·t
        if t > max_distance:                     → 收工,按「逃逸」算(仅性能截断)
        if bias < pen < MARCH_THICKNESS:         → 命中,带回 (yi, xi, t)

出画语义定死:出画就是逃逸,零自由参数(制作人 2026-08-24 拍板)。

## 执行模型

逐射线编译核 + prange 多线程(pbrt/Embree 的共同结构):一线程领一段射线的完整
生命周期,只读场景、只写自己那段结果,零共享写。核只出 `escaped/hit_yx/t_hit`,
**任何归约都不进核**(归约留 numpy 主线程按固定顺序做 ⇒ 产物逐位与线程数无关,
构造性保证,契约测试 6)。`fastmath=False` 钉死(FMA/重排会破字节可复现)。

**没有参考实现、没有降级路径**(制作人铁令:装不上依赖库宁可啥也不干)。
numba 导入失败 ⇒ 报错退出,错误信息给出 wheelhouse 离线安装命令。

## `max_distance` 语义 = 事后过滤(契约测试 7)

`trace(max_distance=r)` ≡ 全程 trace 后按 `t_hit ≤ r` 收窄:
`t_hit ≤ r` 的射线命中记录逐位相同;其余 `escaped=True, hit_yx=-1, t_hit=+inf`。
缺省必须是 inf;任何有限值由调用方显式传,并在调用处注释「为什么这个积分有界」。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .const import (GATHER_SEED, GATHER_STEP_PX, MARCH_BIAS, MARCH_BIAS_GROWTH,
                    MARCH_THICKNESS)

_NUMBA_INSTALL_HINT = (
    'tools/lightbake 需要 numba 编译核,当前环境导入 numba 失败。\n'
    '离线安装(wheelhouse 已含 cp311 win_amd64 轮子):\n'
    '  sh scripts/py.sh -m pip install --no-index '
    '--find-links .tools/wheelhouse_py311 numba==0.67.0 llvmlite==0.49.0\n'
    '没有降级路径(制作人 2026-08-24 铁令):修环境,不要绕过。'
)

try:
    from numba import njit, prange, set_num_threads  # noqa: F401
except Exception as _exc:  # noqa: BLE001 — 统一转成带修复命令的硬错误
    raise ImportError(_NUMBA_INSTALL_HINT) from _exc


#: 可见壳的命中 z 窗(相对像素深度的 (下界, 上界)):march 在 pen ∈ 此窗内记命中。
#: **壳几何的唯一出口** —— NEE 光源采样需要发光 texel 在 march 测度下的真实
#: 几何(像素列 × 此 z 窗的体素箱),从这里拿数据,不许在别处引用判据常量
#: (契约测试 1 只认名字;bias 随 t 的增长项不进箱 —— 长距射线的窗浅端采不中,
#: 由「取 march 注册处辐射」的估计框架自洽吸收,只损一点效率不损无偏)。
SHELL_WINDOW = (float(MARCH_BIAS), float(MARCH_THICKNESS))


@dataclass(frozen=True)
class DepthField:
    """被追踪的那个场。一次构造、到处复用,不许每个消费者自己拼。"""

    depth: np.ndarray        # (h,w) float32 连续,q 空间深度
    ppu: float
    cx: float
    cy: float
    d_min: float             # depth.min(),预算好,终止条件 3 要用
    #: depth.max()。终止条件 4(后穿)用:qz ≥ d_max + THICKNESS 之后
    #: pen > THICKNESS 对任何像素恒成立、永不可能再命中 —— 精确终止,
    #: 与前穿对称。没有它,`dz=+1` 的射线在数学上永不终止(nogil 核
    #: 静默挂死,审查实测复现)。缺省 inf = 旧行为(手工构造的测试场)。
    d_max: float = math.inf

    @classmethod
    def build(cls, depth: np.ndarray, ppu: float, cx: float, cy: float) -> 'DepthField':
        d = np.ascontiguousarray(depth, np.float32)
        return cls(depth=d, ppu=float(ppu), cx=float(cx), cy=float(cy),
                   d_min=float(d.min()), d_max=float(d.max()))


@dataclass
class TraceResult:
    """全记录,永远带满(12 B/射线)—— 一次 trace 带回任何想要的数据(制作人铁令)。

    - 命中处要什么值(辐射/深度/法线)= 拿 `hit_yx` 索引一次,永不重跑 march;
    - 任何射程的判定 = 对 `t_hit` 的事后过滤:`r 内被挡 ⇔ t_hit ≤ r`。
    """

    escaped: np.ndarray      # (n,) bool —— True = 一路跑出去了
    hit_yx: np.ndarray       # (n,2) int32,命中像素(逃逸射线为 -1)
    t_hit: np.ndarray        # (n,) float32,命中处行进距离(逃逸为 +inf)


@njit(parallel=True, nogil=True, cache=True, fastmath=False)
def _march_kernel(perm, o, d, depth, ppu, cx, cy,
                  step, bias0, grow, thickness, d_min_lim, d_max_lim,
                  max_distance,
                  escaped, hit_y, hit_x, t_hit):  # pragma: no cover — 语义由契约测试钉
    n = o.shape[0]
    h, w = depth.shape
    w_lim = np.float32(w - 1)
    h_lim = np.float32(h - 1)
    for i in prange(n):  # noqa: E741 — 一线程领一段射线,循环体 = 推进循环伪代码逐字
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
            if t > max_distance:
                break                                    # 性能截断,按逃逸算
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
    置换以**下标间接**方式进核(审查纠正:物化 o[perm] + 逆置换的拷贝开销
    比核本身还贵),只改调度不改任何结果。

    缓存只对**定长**调用方生效(gather/矩/体侧同一 n 反复 trace);
    AO 的逐样本活跃子集 n 每次都不同,天然 miss(单次 permutation(295k)
    实测 ~0.01s,一趟 AO ~+0.6s,认下)—— maxsize=8 封顶常驻内存(复审纠正:
    32 档会挂 ~75MB 死数据)。返回数组置只读:核只拿它当索引,谁原地改了
    它,核就会静默漏写结果槽。
    """
    rng = np.random.default_rng([GATHER_SEED, n])
    p = rng.permutation(n)
    p.flags.writeable = False
    return p


def trace(origins_q: np.ndarray, dirs_q: np.ndarray, field: DepthField, *,
          max_distance: float = math.inf) -> TraceResult:
    """一批射线的求交。(n,3) q 空间起点 + (n,3) 单位方向。

    `max_distance` 缺省无穷;仅性能截断,语义 ≡ 全程 trace 后按 `t_hit ≤ r` 过滤
    (契约测试 7)。tracer 自己没有任何射程常量。

    ⚠ 前置条件(复审指出,写明):终止 3/4 是**瞬时**判据,不看方向 ——
    起点 qz 已在 (d_min−1e-3, d_max+THICKNESS+1e-3) 之外的射线第一步即按
    逃逸收工,即使它朝着场景走。生产调用方天然满足(表面点 qz∈[d_min,d_max];
    体侧被埋格已剔除、开阔格与场景同带);从带外起点发射是未定义用法。
    """
    o = np.ascontiguousarray(origins_q, np.float32)
    d = np.ascontiguousarray(dirs_q, np.float32)
    n = len(o)
    if n == 0:
        return TraceResult(np.zeros(0, np.bool_),
                           np.full((0, 2), -1, np.int32),
                           np.zeros(0, np.float32))
    # t 的量纲、max_distance 的语义都建立在单位方向上;(0,0,0) 这类退化方向
    # 还会让核永不终止 —— 入口一次性挡掉(审查实测过挂死)。
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
                  # f32:与「事后按 t_hit ≤ r 过滤」(f32 比较)逐位同一语义;
                  # f64 传参会在 r 落在 f32 相邻档间时与过滤语义分叉(审查实测)
                  np.float32(max_distance),
                  escaped, hit_y, hit_x, t_hit)
    return TraceResult(escaped, np.stack([hit_y, hit_x], 1), t_hit)


def buried(pts_q: np.ndarray, field: DepthField) -> np.ndarray:
    """(n,) bool:点是否埋在可见壳后面(帧内且 `pen₀ > MARCH_BIAS`)。

    「埋没」是 t=0 处的壳入口判定,属于 tracer;validity(§5.9)从这里拿,
    消费者不许自己算 pen。**出画的点不算埋** —— 与「出画就是逃逸」同一门风
    (审查纠正:此前用 clip 拿边缘像素判,同一个出画点 buried() 说埋、
    trace() 第一步却逃逸,判据自相矛盾)。
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
    `trace()` 签名不变,产物与线程数无关(契约测试 6)。"""
    if n and n > 0:
        set_num_threads(n)
