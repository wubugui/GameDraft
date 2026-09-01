"""probe 分布 —— 烘焙器里专门的一个模块,策略可换、密度可调。

制作人 2026-09-01 定:「这个 probe 密度在烘焙的时候要能够灵活调节分布啊!
这是一个烘焙器里专门的模块,**现在先用一个简单的探针均匀分布算法占位**」。

## 为什么它必须是独立模块

实测(29 个背景)旧写法把密度与盒子**写死**在 `pipeline.DEFAULTS` 里:
`probe_nx/ny/nz = 20/6/14`、`probe_band = 1.6`。而 `probe_band` 建立在
「角色高 1.5 wu」的假设上,**实测角色是 0.17~0.97 wu**(逐场景,取决于取景远近),
差 1.6~9.4 倍。后果:

- 盒高 1.6 wu / 6 层 = 每层 0.357 wu;
- 角色纵向跨越的层数中位 **1.14 层**,最差 0.45 层(雾津街头/bridge/test_room_a);
- 也就是**整个角色从头到脚共用一个 E**,立体感全靠法线贴图硬撑,
  走两步跨过格边界还整体跳一下色。

换积分算法只能修「这一个 E 算得准不准」,修不了「全身只有一个 E」——
那是分布问题,所以单独一个模块,并且密度是**烘焙期参数**不是常量。

## 当前形式的硬约束(重要)

运行时着色器 `CharacterShadingFilter.probeE` 做的是**规则网格上的三线性**:
`(Xw - uWMin) * uWScale` -> `ivec3` -> 8 角加权,flat 索引
`ix*(ny*nz) + iy*nz + iz`。载荷里只有 `probes:{nx,ny,nz}` 与世界 AABB。

=> **本模块目前只能产规则网格。** 自适应密度(墙边加密、空地稀疏)、八叉树、
不规则点云都要先改载荷与着色器 —— 那是「形式」改动,本次收窄里不做。
策略接口先摆在这,占位实现是 `uniform_grid`。
"""
from __future__ import annotations

from dataclasses import dataclass, field as _field
from typing import Callable

import numpy as np

__all__ = ['ProbeLayout', 'STRATEGIES', 'build_layout', 'register',
           'dilate_invalid', 'reachable_box', 'grid_points', 'DEFAULT_STRATEGY']

DEFAULT_STRATEGY = 'uniform_grid'

#: 载荷体积的护栏。L2 图集 = P x 9 x 4ch x 2B;20 万颗 = 14.4 MB/背景,
#: bins 那张同密度是 92 MB —— 越过这条就该先谈形式改动,而不是闷头烘。
MAX_PROBES_DEFAULT = 200_000


@dataclass
class ProbeLayout:
    """一次布点的完整结果。`world_pos` 的顺序**就是**载荷的 flat 顺序。"""

    grid: tuple[int, int, int]
    bounds: dict                     # x0,x1,y0,y1,z0,z1 世界 AABB
    world_pos: np.ndarray            # (P,3) float32,C 序 (x,y,z)
    strategy: str
    params: dict = _field(default_factory=dict)
    note: str = ''

    @property
    def count(self) -> int:
        return int(self.world_pos.shape[0])

    def cell_size(self) -> tuple[float, float, float]:
        nx, ny, nz = self.grid
        b = self.bounds
        return ((b['x1'] - b['x0']) / max(nx - 1, 1),
                (b['y1'] - b['y0']) / max(ny - 1, 1),
                (b['z1'] - b['z0']) / max(nz - 1, 1))


def grid_points(grid: tuple[int, int, int], bounds: dict) -> np.ndarray:
    """格点世界坐标 (nx*ny*nz, 3) float32,C 序 (x,y,z)。

    ⚠ 顺序必须与着色器的 `flat = ix*(ny*nz) + iy*nz + iz` 一致 ——
    `meshgrid(indexing='ij')` + C 序 reshape 恰好就是它。换成 'xy' 或
    Fortran 序 = 整份载荷错位,画面上表现为「光乱跳」而不报任何错。
    """
    nx, ny, nz = grid
    gx = np.linspace(bounds['x0'], bounds['x1'], nx)
    gy = np.linspace(bounds['y0'], bounds['y1'], ny)
    gz = np.linspace(bounds['z0'], bounds['z1'], nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    return np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)


def reachable_box(world: np.ndarray, band: float, char_wu: float | None = None,
                  height_chars: float = 2.0) -> dict:
    """角色够得着的那一带的世界 AABB。

    x/z 取可见面的 1~99 分位(掐掉边缘外推的野值);
    y 覆盖「最低地面 -> 中位地面 + 角色带」。
    ⚠ 地面本身的起伏常常比角色还高,必须一并覆盖,否则远处地面上的角色
      会落到网格外被钳到边界层(旧 probe 系统踩过:远端角色有效插值权重为 0)。
    """
    px_, py_, pz_ = (world[..., i].ravel() for i in range(3))
    x0, x1 = (float(v) for v in np.percentile(px_, [1, 99]))
    z0, z1 = (float(v) for v in np.percentile(pz_, [1, 99]))
    # 盒高 = **地面起伏 + 角色身高 x height_chars**(制作人 2026-09-01)。
    # 上界跟地面走,不跟画面最高点走;但必须把「站在最高地面上的人」整个装进去 ——
    # 纯 `height_chars x char` 在有坡的场景兜不住(实测 bridge_underpass
    # 地面起伏 0.374 wu > 角色 0.170x2 = 0.341,站高处的人整个在盒外)。
    #
    # ⚠ 这里拿到的是**整片可见面**的点云(含墙面/屋顶),不是地面高度场,
    #   所以上界取 P60 当「地面带顶」的代理 —— 取 P98 会把屋顶算进来,盒子直接飞。
    #   `pipeline.world_bounds` 那条路拿的是真正的地面场 `Yg`,用的是 P98。
    ch = float(char_wu) if char_wu else float(band) / 1.15
    y0 = float(np.percentile(py_, 2)) - 0.05 * ch
    y1 = float(np.percentile(py_, 60)) + float(height_chars) * ch
    return {'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1, 'z0': z0, 'z1': z1}


def uniform_grid(world: np.ndarray, char_wu: float, *,
                 dims: tuple[int, int, int] | None = None,
                 cells_per_char_xz: float = 4.0,
                 cells_per_char_y: float = 2.0,
                 height_chars: float = 2.0,
                 band: float | None = None,
                 bounds: dict | None = None,
                 max_probes: int = MAX_PROBES_DEFAULT,
                 **_kw) -> ProbeLayout:
    """占位策略:盒内均匀规则网格。

    两种定密度的方式,二选一:

    - `dims=(nx,ny,nz)` —— 显式给格数(旧行为 = `(20,6,14)`);
    - 否则按**角色高度**推,横纵**各自独立**:
      横向每角色高 `cells_per_char_xz` 格、纵向 `cells_per_char_y` 格。
      两者不许再互相绑定 —— 盒高只有 `height_chars` 个角色高,纵向本就不缺层,
      而水平方向一个格子可能跨半条巷子(实测:纵向 2 格/角色高已足够,水平不够)。

    `height_chars` = 盒总高 / 角色身高(缺省 2.0)。**不覆盖全场景最高点**。
    `band` 只在没给 `bounds` 时用来定 x/z 分位,不再决定盒高。

    `bounds` 显式给盒(pipeline 走这条:盒还要喂 `manifest.world`,
    与摆灯/行走面共用同一个,不能这里再算一个第二真相源)。
    """
    # ⚠ 横纵**解耦**(制作人 2026-09-01:「纵向 2 格够了,水平必须提起来」)。
    #   旧写法 `cells_per_char_y = cells_per_char_xz * 2` 把两者焊死,一提水平
    #   纵向就跟着涨 —— 而纵向那几层是**最不缺**的(盒高只有 2 个角色高)。
    if band is None:
        band = char_wu * 1.15
    if bounds is None:
        bounds = reachable_box(world, band, char_wu=char_wu, height_chars=height_chars)
    capped = False
    if dims is not None:
        nx, ny, nz = (int(v) for v in dims)
        nx, ny, nz = max(2, nx), max(2, ny), max(2, nz)
    else:
        cell_xz = max(char_wu / max(cells_per_char_xz, 1e-6), 1e-4)
        cell_y = max(char_wu / max(cells_per_char_y, 1e-6), 1e-4)
        nx = max(4, int(round((bounds['x1'] - bounds['x0']) / cell_xz)) + 1)
        nz = max(4, int(round((bounds['z1'] - bounds['z0']) / cell_xz)) + 1)
        ny = max(4, int(round((bounds['y1'] - bounds['y0']) / cell_y)) + 1)
        total = nx * ny * nz
        if total > max_probes:
            s = (max_probes / total) ** (1.0 / 3.0)
            nx = max(4, int(nx * s))
            ny = max(4, int(ny * s))
            nz = max(4, int(nz * s))
            capped = True
    grid = (nx, ny, nz)
    pts = grid_points(grid, bounds)
    cell = ((bounds['x1'] - bounds['x0']) / max(nx - 1, 1),
            (bounds['y1'] - bounds['y0']) / max(ny - 1, 1),
            (bounds['z1'] - bounds['z0']) / max(nz - 1, 1))
    note = (f'角色 {char_wu:.3f} wu / 盒高 {bounds["y1"]-bounds["y0"]:.3f} wu;'
            f'格 {cell[0]:.3f}x{cell[1]:.3f}x{cell[2]:.3f} wu;'
            f'角色纵向跨 {char_wu / max(cell[1], 1e-9):.2f} 层')
    if capped:
        note += f' ⚠ 被 max_probes={max_probes} 削过'
    return ProbeLayout(grid=grid, bounds=bounds, world_pos=pts,
                       strategy='uniform_grid',
                       params={'dims': list(grid), 'band': float(band),
                               'cells_per_char_xz': float(cells_per_char_xz),
                               'cells_per_char_y': float(cells_per_char_y),
                               'height_chars': float(height_chars),
                               'max_probes': int(max_probes)},
                       note=note)


def legacy_fixed(world: np.ndarray, char_wu: float, **_kw) -> ProbeLayout:
    """旧行为,一字不改:20x6x14 + band 1.6 wu。**只用于 A/B 对照**。

    留着它是为了能把新算法与旧分布分开归因 —— 换了积分又换了分布,
    画面变了说不清是哪一半的功劳。生产不要用:6 层里有 5 层烘在角色够不着的空中。
    """
    for k in ('dims', 'band', 'bounds', 'height_chars'):
        _kw.pop(k, None)             # 旧盒必须自己算,不许外面塞
    # ⚠ 旧盒的高度由 **band=1.6** 与地面分位拼出来,不是「角色身高 x N」——
    #   `reachable_box` 已经改成新口径了,这里必须把老式子原样写回来,
    #   否则 A/B 两边都用新盒,legacy 就不再是 legacy(实测:老盒被算成新盒,
    #   角色纵向跨层从 0.30 变成 2.50,对照失去意义)。
    py_ = world[..., 1].ravel()
    px_, pz_ = world[..., 0].ravel(), world[..., 2].ravel()
    y0 = float(np.percentile(py_, 2)) - 0.02
    old_bounds = {
        'x0': float(np.percentile(px_, 1)), 'x1': float(np.percentile(px_, 99)),
        'z0': float(np.percentile(pz_, 1)), 'z1': float(np.percentile(pz_, 99)),
        'y0': y0, 'y1': max(float(np.percentile(py_, 60)) + 1.6, y0 + 1.6 * 1.5)}
    lay = uniform_grid(world, char_wu, dims=(20, 6, 14), band=1.6,
                       bounds=old_bounds, **_kw)
    lay.strategy = 'legacy_fixed'
    lay.note += ' ⚠ 旧分布,仅供 A/B'
    return lay


#: 策略注册表。加新分布往这加一行 —— 但先读模块文档的「当前形式的硬约束」。
STRATEGIES: dict[str, Callable[..., ProbeLayout]] = {
    'uniform_grid': uniform_grid,
    'legacy_fixed': legacy_fixed,
}


def register(name: str, fn: Callable[..., ProbeLayout]) -> None:
    STRATEGIES[name] = fn


def build_layout(strategy: str, world: np.ndarray, char_wu: float,
                 **kw) -> ProbeLayout:
    fn = STRATEGIES.get(strategy)
    if fn is None:
        raise ValueError(f'未知 probe 分布策略 {strategy!r}'
                         f'(可选 {"/".join(sorted(STRATEGIES))})')
    return fn(world, char_wu, **kw)


# ------------------------------------------------------ validity + dilation

_SHIFTS = ((0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1))


def dilate_invalid(valid: np.ndarray, fields: list[np.ndarray],
                   max_iters: int = 64) -> tuple[np.ndarray, int]:
    """反复用 6-邻域**有效**格点的均值填 invalid,直到没有 invalid 与 valid
    相邻(或达上限)。AAA 探针体系的标准手段(Unity Dilation / UE validity)。

    为什么**必做不是可选**:新 tracer 对被埋格点给的是精确 0(它确实什么都
    看不见),运行时三线性会把这个 0 借给邻格,把贴墙的角色压暗。旧管线靠
    `valid` 恒为 1 + fold 把这问题糊过去了;删掉 fold 之后必须真的填。

    `valid` 与 `fields` 都是 (nx,ny,nz[,...]) 形状;`fields` 原地改。
    """
    valid = valid.copy()
    it = 0
    while it < max_iters and not valid.all():
        cnt = np.zeros(valid.shape, np.float64)
        sums = [np.zeros(f.shape, np.float64) for f in fields]
        for axis, sgn in _SHIFTS:
            src = [slice(None)] * 3
            dst = [slice(None)] * 3
            if sgn > 0:
                src[axis] = slice(1, None)
                dst[axis] = slice(None, -1)
            else:
                src[axis] = slice(None, -1)
                dst[axis] = slice(1, None)
            src_t, dst_t = tuple(src), tuple(dst)
            vsrc = valid[src_t]
            cnt[dst_t] += vsrc
            w = vsrc.astype(np.float64)
            for f, acc in zip(fields, sums, strict=True):
                extra = f.ndim - 3
                acc[dst_t] += f[src_t] * w.reshape(w.shape + (1,) * extra)
        fill = (~valid) & (cnt > 0)
        if not fill.any():
            break
        for f, acc in zip(fields, sums, strict=True):
            c = cnt[fill]
            extra = f.ndim - 3
            f[fill] = (acc[fill] / c.reshape(c.shape + (1,) * extra)).astype(f.dtype)
        valid |= fill
        it += 1
    return valid, it
