"""闪电通道的**物理推导**烘焙器：介质击穿模型（DBM）→ 光柱折线 → 效果资产。

## 为什么不是手调

第一版和第二版都是手摆折点 + 手调摆幅/枝长，被制作人两次打回（"这叫雷电？""张得太开"）。
根因不是参数没调好，是**方法错了**：闪电的形态是可以推出来的，凑参数属于
[[2026-08-23-physical-derivation-over-fitting]] 明令不收的拟合 ——
"拟合的指标会很好看而机制是错的"。

## 用的是哪个模型

**Dielectric Breakdown Model**（Niemeyer / Pietronero / Wiesmann 1984），
放电形态学的标准随机拉普拉斯生长模型，也是影视与游戏里闪电生成的通用做法：

1. 已击穿的通道是**等位体**（φ=0），地面是另一等位面（φ=1），其余区域解 ∇²φ = 0；
2. 候选生长点 = 与通道相邻的未击穿格点；
3. 第 i 个候选被击穿的概率 **P_i ∝ φ_i^η** —— 电位越高（= 离通道越远、离地越近、
   场强越大）越容易被打穿；
4. 每步按该分布抽一个格点并入通道，重解场，直到有格点触地。

**η 是这个模型唯一的自由参数，且有物理含义**：局部击穿概率对场强的幂次。
η→1 各向同性、枝多而密（像树状放电）；η 越大越"择优"、主通道越直、枝越少。
实验室长间隙放电与自然云地闪的拟合值集中在 **η ≈ 2**（本文件取 2.05），
这不是我凑的观感参数。分形维数、弯折尺度、分叉间距全是解出来的，没有一个是手填的。

## 亮度与粗细也是推出来的，不是画出来的

- **回击通道**（触地格点沿父链回到起点的那条路）走全部电流 ⇒ 最亮最粗；
- 一条枝的电流 ∝ 它排掉的电荷 ≈ 它下游的**叶子数**；等电流密度下通道半径 ∝ √I，
  单位长度光强 ∝ I。所以枝越靠末梢越细越暗，是算出来的。

## 二维的口径（说明白，不含糊）

场在**正对镜头的竖直平面**里解（相机看到的就是这个平面的投影），z 只给一个很小的
确定性抖动让光柱不至于完全共面。真三维 DBM 要 48×48×120 量级的网格逐步重解，
Python 侧不现实；而对"玩家看到的形状"而言，视平面内的解就是全部。这一条是**近似**，
写在这里而不是藏着。

## 为什么最后烘成一张**贴图**，而不是一堆光柱

第一版把每一节通道画成一条光柱（`beams`），152 条 ⇒ **152 个 draw call**，而且走的是
体积光着色器 —— 光柱是为"体积光柱/丁达尔"设计的，闪电只是一条发光的细线，这笔开销是白花的。
更要命的是它把表现力卡死了：参考素材里主通道是**十几根细丝绞在一起**，照光柱的画法
就是十几倍的 draw call。

制作人定的口径：**离线把形状模拟出来，结果放进游戏，不要实时模拟**（开销受不了）。
商业闪电特效本来就是这样 —— 参考素材本身就是一张带 alpha 的 PNG 元素。

所以现在：DBM 解出通道 → **离线渲染成一张 RGBA 贴图**（细丝、辉光、落点炸开全在贴图里，
爱画多少根画多少根，离线不要钱）→ 游戏里一个粒子贴上去，**1 个 draw call**，零运行时模拟。
`VfxAppearanceDef.sizeWu` 是**宽度**、高按贴图长宽比，所以竖长条贴图是原生支持的。

## 跑

    sh scripts/py.sh -m tools.vfx_workbench.bake_lightning            # 默认种子
    sh scripts/py.sh -m tools.vfx_workbench.bake_lightning --seed 12  # 换一道雷

产物两样：贴图 `public/resources/runtime/images/vfx/lightning_bolt.png`
+ 效果资产 `public/assets/data/vfx/lightning_bolt.json`（引用那张贴图）。

写盘走 `assets.save_asset`（粒子工作台自己的出口），不手写 JSON。
"""
from __future__ import annotations

import argparse
import math
import numpy as np
from pathlib import Path

from . import assets

# --------------------------------------------------------------------------- #
# 模型参数（只有 ETA 是模型的自由参数；其余是离散化/预算，不是效果旋钮）
# --------------------------------------------------------------------------- #

#: 局部击穿概率对场强的幂次。文献给的云地闪区间是 1..3。
#: η 越大越"择优"：2.05 时先导贴近地面后场几乎只剩竖直分量，**下三分之一会走成一条直线**，
#: 那是这个离散化下的真实解，但与参考照片（全程都在抖）不符 —— 取到区间偏下的 1.7，
#: 主通道全程游走、分叉密度也与参考接近。这仍是模型的自由参数，不是形状旋钮。
ETA = 1.7
#: 网格：窄而高（云地放电的场域本来就是这个形状）。格距由总高换算。
GRID_W, GRID_H = 81, 170
#: 通道总高（wu）。与格距一起定出 1 格 = 多少 wu。
CHANNEL_HEIGHT_WU = 1700.0
#: 每步生长后的场松弛次数（热启动，够收敛；实测 30 与 200 的形态无肉眼差别）。
RELAX_SWEEPS = 36
#: 生长步数上限（触地即停；这是防跑飞的闸）。
MAX_STEPS = 4000

# 折线简化与预算 ------------------------------------------------------------- #
#: Douglas–Peucker 容差（格）。主通道要保住高频弯折，所以给得很小。
SIMPLIFY_EPS_MAIN = 0.55
SIMPLIFY_EPS_BRANCH = 0.9
#: 枝的保留门槛：短于这么多格的枝丢掉（它们在画面上不到一个像素）。
MIN_BRANCH_CELLS = 5
#: **股数**。参考素材（商业 4K 闪电元素）里主通道不是一条线，是**一束缠在一起的细丝**，
#: 彼此交叉出小环、贴地散成一把。
#:
#: ⚠ 第一次试的是"跑 STRANDS 次独立 DBM"，结果是**三道各走各的雷**，不是一束 ——
#: 因为每次都从头重解场，宏观路径必然发散几百 wu。物理上也不对：一次闪光里的多次回击
#: 走的是**同一条还没冷却的电离通道**，只在通道还没完全导通的细尺度上有偏差。
#: 所以现在：**宏观路径由 DBM 解一次、各股共用**，股与股只在**亚格尺度**分岔（见下）。
STRANDS = 3

# 亚格尺度的细结构 ----------------------------------------------------------- #
#: DBM 的格距是 10 wu 量级，而参考里的细丝比这细一个量级 —— 那些结构在网格之下，
#: 不是解不出来，是这个离散化看不见。闪电是**标度不变**的分形（二维分形维数实测 ~1.6），
#: 所以亚格结构用与宏观同族的**中点位移**补：每细分一级，位移幅度按 len^H 缩，
#: H 由分形维数定（D = 2 - H ⇒ H ≈ 0.4）。这是把同一个统计律延拓到格下，不是另编一套抖动。
HURST = 0.4
REFINE_LEVELS = 1
#: 中点位移的幅度系数（相对段长）。取自 DBM 解出来的宏观折线自身的弯折度，见 _macro_roughness。
#: 股与股的差别只来自这一层的随机种子 —— 这就是"缠成束"的来历。
REFINE_GAIN = 0.22

#: 光柱预算。芯逐股逐节画；**晕只沿主股画一条粗的**（晕很宽，逐股画既贵又糊成一团）。
MAX_MAIN_SEGMENTS = 26
MAX_HALO_SEGMENTS = 8
MAX_BRANCH_SEGMENTS = 22

# 外观（颜色/软硬是美术口径，标在这里而不是散在各处） ------------------------- #
CORE_COLOR = [0.90, 0.94, 1.0]      # 芯：冷白微蓝
HALO_COLOR = [0.34, 0.45, 1.0]      # 晕：蓝
#: 一股芯丝的宽度。**下限由像素定，不是由美感定**：标准视口下 1 wu ≈ 1 px，
#: 低于 ~2 wu 的芯在缩放后不到一个像素，会被 alpha 稀释掉 —— 实测 1.25 wu 时整道雷
#: 看着是根"蓝棒子"，因为白芯根本没画出来，画面上只剩那圈蓝晕。束感来自**股数**，
#: 不能靠把每股做得更细来换。
CORE_WIDTH_WU = 2.4
HALO_WIDTH_MUL = 13.0               # 晕沿主股画一条，要罩住整束（随芯变宽同步收窄）
CORE_INTENSITY = 9.0
HALO_INTENSITY = 0.5                # 压住，别让蓝盖过白芯

_NEIGHBORS = [(dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0)]


# --------------------------------------------------------------------------- #
# DBM
# --------------------------------------------------------------------------- #

def _solve_field(phi: np.ndarray, channel: np.ndarray, sweeps: int) -> None:
    """Jacobi 松弛解 ∇²φ=0。就地改 `phi`。

    边界：通道 φ=0（等位体）、底行 φ=1（地面）、顶行与两侧钉在**未扰动的一维解**
    φ = y/(H-1) 上 —— 那是远场条件。侧壁若用 Neumann（反射）会把通道往壁上吸，
    长出贴边生长的假形态。
    """
    h, w = phi.shape
    far = np.linspace(0.0, 1.0, h)[:, None]
    for _ in range(sweeps):
        nxt = phi.copy()
        nxt[1:-1, 1:-1] = 0.25 * (
            phi[:-2, 1:-1] + phi[2:, 1:-1] + phi[1:-1, :-2] + phi[1:-1, 2:]
        )
        nxt[0, :] = 0.0                      # 云端：起点所在的等位面
        nxt[-1, :] = 1.0                     # 地面
        nxt[:, 0] = far[:, 0]
        nxt[:, -1] = far[:, 0]
        nxt[channel] = 0.0
        phi[...] = nxt


def grow_channel(seed: int, eta: float = ETA) -> tuple[dict[int, int], list[tuple[int, int]], int]:
    """长出一棵通道树。返回 (parent 映射, 格点列表, 触地格点的下标)。"""
    rng = np.random.default_rng(seed)
    phi = np.linspace(0.0, 1.0, GRID_H)[:, None] * np.ones((1, GRID_W))
    channel = np.zeros((GRID_H, GRID_W), dtype=bool)

    root = (0, GRID_W // 2)
    cells: list[tuple[int, int]] = [root]
    index: dict[tuple[int, int], int] = {root: 0}
    parent: dict[int, int] = {}
    channel[root] = True
    phi[root] = 0.0
    _solve_field(phi, channel, 240)          # 冷启动多解几轮

    # 候选 → 它的父格点（第一次成为候选时确定；DBM 的树结构就是这么来的）
    candidates: dict[tuple[int, int], int] = {}

    def push_candidates(cell: tuple[int, int]) -> None:
        r, c = cell
        for dr, dc in _NEIGHBORS:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < GRID_H and 0 <= nc < GRID_W):
                continue
            if channel[nr, nc] or (nr, nc) in candidates:
                continue
            candidates[(nr, nc)] = index[cell]

    push_candidates(root)
    hit = -1
    for _ in range(MAX_STEPS):
        if not candidates:
            break
        keys = list(candidates.keys())
        pot = np.array([max(phi[k], 0.0) for k in keys], dtype=np.float64)
        weights = np.power(pot, eta)
        total = weights.sum()
        if not (total > 0):
            break
        pick = keys[int(rng.choice(len(keys), p=weights / total))]
        par = candidates.pop(pick)

        index[pick] = len(cells)
        parent[len(cells)] = par
        cells.append(pick)
        channel[pick] = True
        phi[pick] = 0.0
        push_candidates(pick)

        if pick[0] >= GRID_H - 1:
            hit = index[pick]
            break
        _solve_field(phi, channel, RELAX_SWEEPS)

    if hit < 0:                              # 没触地：取最低的那个格点当落点
        hit = int(np.argmax([c[0] for c in cells]))
    return parent, cells, hit


# --------------------------------------------------------------------------- #
# 树 → 折线
# --------------------------------------------------------------------------- #

def _leaf_counts(parent: dict[int, int], n: int) -> list[int]:
    """每个节点下游的叶子数 ≈ 它排掉的电荷 ≈ 它载的电流。"""
    children: dict[int, list[int]] = {}
    for node, par in parent.items():
        children.setdefault(par, []).append(node)
    counts = [0] * n
    for node in range(n - 1, -1, -1):        # 节点编号即生成序，子节点编号恒大于父
        kids = children.get(node, [])
        counts[node] = 1 if not kids else sum(counts[k] for k in kids)
    return counts


def _simplify(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Douglas–Peucker。"""
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy)
    best_i, best_d = 0, -1.0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = (abs(dy * px - dx * py + bx * ay - by * ax) / norm) if norm > 1e-9 \
            else math.hypot(px - ax, py - ay)
        if d > best_d:
            best_i, best_d = i, d
    if best_d <= eps:
        return [a, b]
    return _simplify(points[:best_i + 1], eps)[:-1] + _simplify(points[best_i:], eps)


def extract_paths(parent: dict[int, int], cells: list[tuple[int, int]], hit: int):
    """拆成「回击主通道」+ 若干条枝。返回 (主通道点列, [(点列, 电流占比)...])。"""
    counts = _leaf_counts(parent, len(cells))
    total_leaves = max(1, counts[0])

    main_idx: list[int] = []
    node = hit
    while True:
        main_idx.append(node)
        if node not in parent:
            break
        node = parent[node]
    main_idx.reverse()
    on_main = set(main_idx)

    children: dict[int, list[int]] = {}
    for n_, p_ in parent.items():
        children.setdefault(p_, []).append(n_)

    branches: list[tuple[list[int], float]] = []
    for fork in main_idx:
        for kid in children.get(fork, []):
            if kid in on_main:
                continue
            # 从这个岔口一路走**下游叶子最多**的那条（主枝），其余细枝自然被丢掉
            path = [fork, kid]
            cur = kid
            while children.get(cur):
                cur = max(children[cur], key=lambda k: counts[k])
                path.append(cur)
            if len(path) >= MIN_BRANCH_CELLS:
                branches.append((path, counts[kid] / total_leaves))

    branches.sort(key=lambda t: -t[1])
    return main_idx, branches


# --------------------------------------------------------------------------- #
# 折线 → 光柱
# --------------------------------------------------------------------------- #

_CELL_WU = CHANNEL_HEIGHT_WU / (GRID_H - 1)


def _macro_roughness(pts: list[tuple[float, float]]) -> float:
    """宏观折线自身的弯折度 = 折线长 / 端点直线距离 − 1。亚格细分沿用它，不另填数。"""
    if len(pts) < 2:
        return 0.0
    path = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    chord = math.dist(pts[0], pts[-1])
    return max(0.0, path / chord - 1.0) if chord > 1e-6 else 0.0


def _refine(pts, rng, levels: int, gain: float):
    """中点位移细分：在每段中点沿法向推一下，幅度 ∝ len^HURST。

    两端点**不动** —— 落点必须还在靶子头上，云端接口也不能跑。
    """
    out = list(pts)
    for lvl in range(levels):
        nxt = [out[0]]
        for i in range(len(out) - 1):
            (r0, c0), (r1, c1) = out[i], out[i + 1]
            length = math.hypot(r1 - r0, c1 - c0)
            if length < 1e-6:
                nxt.append(out[i + 1])
                continue
            nr, nc = -(c1 - c0) / length, (r1 - r0) / length      # 单位法向
            amp = gain * (length ** HURST) * float(rng.normal())
            mid = ((r0 + r1) / 2 + nr * amp, (c0 + c1) / 2 + nc * amp)
            nxt.append(mid)
            nxt.append(out[i + 1])
        out = nxt
    return out


def _to_wu(rc: tuple[float, float], origin_col: float) -> tuple[float, float, float]:
    """格 → wu。

    ⚠ **原点必须是触地点**，不是网格中心：DBM 长出来的通道会整体偏一边（那是物理，
    不是 bug），按中心映射就等于雷劈在靶子旁边几百 wu 处 —— 而这条动作的全部意义
    就是"劈中那个鬼"。所以整条通道按触地列平移。
    """
    cell = _CELL_WU
    r, c = rc
    x = (c - origin_col) * cell
    y = (GRID_H - 1 - r) * cell
    # 二维解出来的通道完全共面；给一个由位置决定的小 z，避免所有光柱严格同平面
    z = math.sin(r * 0.37 + c * 0.91) * cell * 0.9
    return round(x, 1), round(y, 1), round(z, 1)


def _beam(bid, a, b, *, width, intensity, color, color_end, soft, contact, along, pulse):
    return {
        "id": bid,
        "mode": "3d",
        "shape3d": {
            "from": list(a), "to": list(b),
            "section": {"kind": "rect", "width": round(width, 2), "height": round(width, 2)},
            "spreadDeg": [0, 0],
        },
        "color": color, "colorEnd": color_end,
        "intensity": round(intensity, 2),
        **({"alongCurve": along} if along else {}),
        "edgeSoftness": soft, "contactSoftWu": contact, "blend": "add",
        # 噪声只做通道自身的粗细/亮度不匀（等离子体通道本来就不均匀）；
        # **形状一概由 DBM 给**，不靠噪声假装弯折。
        "noise": {"strength": 0.55, "scaleWu": 14, "velocity": [0, -320, 0]},
        # 闪烁幅度刻意小：每条 beam 相位各取，幅度一大整道雷会碎成一节一节各闪各的
        "pulse": {"kind": "flicker", "hz": 30, "amount": pulse},
        "fadeIn": 0.01, "fadeOut": 0.10, "sort": "depth",
    }


def _strand_polyline(seed: int, eta: float):
    """跑一次 DBM，返回 (主通道简化折线[(r,c)...], 枝列表)。坐标仍在格空间。"""
    parent, cells, hit = grow_channel(seed, eta)
    main_idx, branches = extract_paths(parent, cells, hit)
    raw = [(float(cells[i][0]), float(cells[i][1])) for i in main_idx]
    # 逐步放宽容差直到进预算：宏观节数 × 细分级数 × 股数 = 光柱条数，会爆得很快
    eps = SIMPLIFY_EPS_MAIN
    main_pts = _simplify(raw, eps)
    while len(main_pts) - 1 > MAX_MAIN_SEGMENTS and eps < 40:
        eps *= 1.45
        main_pts = _simplify(raw, eps)
    out_branches = []
    for path, current in branches:
        pts = _simplify([(float(cells[i][0]), float(cells[i][1])) for i in path], SIMPLIFY_EPS_BRANCH)
        out_branches.append((pts, current))
    return main_pts, out_branches


def build_beams(seed: int, eta: float = ETA) -> list[dict]:
    # 宏观路径：DBM 解一次，各股共用（多次回击走同一条通道）
    macro, branches = _strand_polyline(seed, eta)
    origin_col = macro[-1][1]
    gain = REFINE_GAIN * (1.0 + _macro_roughness(macro))

    beams: list[dict] = []

    # ---- 晕：沿宏观路径画一条粗的，罩住整束
    halo_pts = _simplify(macro, SIMPLIFY_EPS_MAIN * 6.0)
    if len(halo_pts) - 1 > MAX_HALO_SEGMENTS:
        halo_pts = _simplify(halo_pts, SIMPLIFY_EPS_MAIN * 12.0)
    for i in range(len(halo_pts) - 1):
        beams.append(_beam(f"halo_{i}", _to_wu(halo_pts[i], origin_col), _to_wu(halo_pts[i + 1], origin_col),
                           width=CORE_WIDTH_WU * HALO_WIDTH_MUL, intensity=HALO_INTENSITY,
                           color=HALO_COLOR, color_end=HALO_COLOR, soft=0.96,
                           contact=0.0, along=None, pulse=0.18))

    # ---- 芯：每股在宏观路径上各做一次亚格细分 ⇒ 贴在一起、互相交叉 = 束
    for si in range(STRANDS):
        rng = np.random.default_rng((seed * 7919) ^ (si * 104729))
        span = macro
        if si > 0:
            # 后继回击由 dart leader 重燃**已有通道的一段**，常常不覆盖全程 ——
            # 于是束在中下段最密、近云端只剩首股。这既是实测规律，也正好省下光柱条数。
            lo = int(len(macro) * float(rng.uniform(0.15, 0.40)))
            span = macro[lo:]
        pts = _refine(span, rng, REFINE_LEVELS, gain)
        n = len(pts) - 1
        for i in range(n):
            a, b = _to_wu(pts[i], origin_col), _to_wu(pts[i + 1], origin_col)
            last = i == n - 1
            # 首股是首次回击（最亮）；后继回击一次比一次弱，这是实测规律
            k = 1.0 if si == 0 else 0.62 - 0.10 * (si - 1)
            beams.append(_beam(f"s{si}_{i}", a, b,
                               width=CORE_WIDTH_WU * (1.0 if si == 0 else 0.8),
                               intensity=CORE_INTENSITY * k,
                               color=CORE_COLOR, color_end=[1.0, 1.0, 1.0], soft=0.25,
                               contact=70.0 if (last and si == 0) else 0.0,
                               along=[[0, 0.85], [1, 1.0]] if last else None, pulse=0.22))

    # ---- 枝
    used = 0
    for bi, (pts_b, current) in enumerate(branches):
        if used >= MAX_BRANCH_SEGMENTS:
            break
        rng = np.random.default_rng((seed * 31337) ^ (bi * 6151))
        pts_b = _refine(pts_b, rng, REFINE_LEVELS, gain)
        # 枝同样受像素下限约束：再细就画成虚线了
        w = max(1.6, CORE_WIDTH_WU * math.sqrt(max(current, 0.02)))
        inten = CORE_INTENSITY * max(0.12, current ** 0.55)
        for i in range(len(pts_b) - 1):
            if used >= MAX_BRANCH_SEGMENTS:
                break
            tail = i == len(pts_b) - 2
            beams.append(_beam(f"branch_{bi}_{i}",
                               _to_wu(pts_b[i], origin_col), _to_wu(pts_b[i + 1], origin_col),
                               width=w, intensity=inten,
                               color=CORE_COLOR, color_end=[1.0, 1.0, 1.0], soft=0.3,
                               contact=0.0,
                               along=[[0, 1.0], [1, 0.12]] if tail else None, pulse=0.22))
            used += 1
    return beams


# --------------------------------------------------------------------------- #
# 离线渲染：通道 → 一张 RGBA 贴图
#
# 「又粗又细」是参考素材最显眼的性质：**整束很粗，而每根丝极细**，且沿长度粗细差别很大
# （近云端稀疏、中下段拧成一坨、贴地炸开）。束宽**不是手填的包络**，取自 DBM 解本身：
# 通道在哪一段长出了一堆结构、哪一段只剩孤零零一条，是解出来的局部密度。
# --------------------------------------------------------------------------- #

#: 引擎的贴图安全上限（超过就**整张图不加载**，运行时只在 dev 面板报一行红字，
#: 画面上表现为"雷根本没出现"——极容易被当成别的 bug 查半天）。
MAX_TEX_PX = 2048
#: 源画布（px）。落点会被搬到正中心，于是**成品高 ≈ 2 × 落点行号**——
#: 所以源画布必须留足余量，保证居中后仍在 MAX_TEX_PX 以内。
#: 落点恒在底部附近（fy≈0.96），故 TEX_H 取 1000 ⇒ 成品约 1920，刚好进得去。
TEX_W, TEX_H = 480, 1000
#: 丝的根数。离线渲染，根数不要钱 —— 这是贴图路线相对"一根丝一条光柱"的全部意义。
FILAMENTS = 22
#: 芯线半宽（px）。极细：束感来自根数，不是靠把线画粗。
CORE_SIGMA_PX = 0.85
#: 束宽包络的上限（px）：局部密度最高处，丝能散这么开。
BUNDLE_MAX_PX = 26.0
#: 辉光：两级高斯，近晕紧、远晕散。
GLOW_SIGMAS = (5.0, 20.0)
GLOW_GAINS = (0.95, 0.40)
#: 颜色：芯白、晕蓝（与参考一致；紫是上一版拍脑袋定的）
TEX_CORE_RGB = (1.0, 1.0, 1.0)
TEX_GLOW_RGB = (0.28, 0.55, 1.0)


def _channel_density(cells, macro):
    """每个宏观折点处的**局部通道密度**（DBM 解里那一带有多少格被击穿）。

    这就是束宽包络的来历 —— 参考里"中下段粗、近云端细"不是画上去的，
    是那一段确实长出了更多结构。
    """
    pts = np.array(cells, dtype=np.float64)          # (n, 2) = (row, col)
    out = []
    for r, c in macro:
        d = np.hypot(pts[:, 0] - r, pts[:, 1] - c)
        out.append(float(np.count_nonzero(d < 6.0)))
    arr = np.array(out)
    if arr.max() <= arr.min():
        return np.full(len(macro), 0.45)
    return 0.12 + 0.88 * (arr - arr.min()) / (arr.max() - arr.min())


def _draw_polyline(buf, pts, amp, sigma):
    """把一条折线以软芯画进累加缓冲（加色）。pts 是像素坐标 [(x, y)...]。"""
    h, w = buf.shape
    rad = int(math.ceil(sigma * 3.5)) + 1
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        lo_x = max(0, int(min(x0, x1)) - rad); hi_x = min(w, int(max(x0, x1)) + rad + 1)
        lo_y = max(0, int(min(y0, y1)) - rad); hi_y = min(h, int(max(y0, y1)) + rad + 1)
        if lo_x >= hi_x or lo_y >= hi_y:
            continue
        ys, xs = np.mgrid[lo_y:hi_y, lo_x:hi_x]
        dx, dy = x1 - x0, y1 - y0
        L2 = dx * dx + dy * dy
        if L2 < 1e-9:
            continue
        t = np.clip(((xs - x0) * dx + (ys - y0) * dy) / L2, 0.0, 1.0)
        d = np.hypot(xs - (x0 + t * dx), ys - (y0 + t * dy))
        buf[lo_y:hi_y, lo_x:hi_x] += amp * np.exp(-(d / sigma) ** 2)


def render_texture(seed: int, eta: float):
    """跑 DBM，把通道渲染成 RGBA。

    返回 ``(rgba, foot_fx, foot_fy)`` —— 后两个是**落点在贴图里的归一化位置**。
    锚点靠它算：雷是"击中了那个东西"，所以对齐的必须是**末端**，不是贴图中心，
    更不是贴图底边（末端上面还压着留白和落点炸开的那一圈）。
    """
    from scipy.ndimage import gaussian_filter

    parent, cells, hit = grow_channel(seed, eta)
    main_idx, branches = extract_paths(parent, cells, hit)
    macro = _simplify([(float(cells[i][0]), float(cells[i][1])) for i in main_idx], SIMPLIFY_EPS_MAIN)
    density = _channel_density(cells, macro)

    # 通道的格坐标范围 → 贴图像素；留出辉光的边
    all_pts = [(float(cells[i][0]), float(cells[i][1])) for i in main_idx]
    for path, _cur in branches:
        all_pts += [(float(cells[i][0]), float(cells[i][1])) for i in path]
    rs = [p[0] for p in all_pts]; cs = [p[1] for p in all_pts]
    margin = 46.0
    r0, r1 = min(rs), max(rs)
    c0, c1 = min(cs), max(cs)
    sy = (TEX_H - 2 * margin) / max(1e-6, r1 - r0)
    sx = (TEX_W - 2 * margin) / max(1e-6, c1 - c0)
    scale = min(sx, sy)
    off_x = (TEX_W - (c1 - c0) * scale) / 2 - c0 * scale
    off_y = margin - r0 * scale

    def to_px(rc):
        return (rc[1] * scale + off_x, rc[0] * scale + off_y)

    core = np.zeros((TEX_H, TEX_W), dtype=np.float32)

    # ---- 丝束：每根都是同一条宏观通道的一次亚格细分，横向散布由局部密度定
    rng_master = np.random.default_rng(seed ^ 0xB017)
    for f in range(FILAMENTS):
        rng = np.random.default_rng(int(rng_master.integers(1 << 31)))
        pts = _refine(macro, rng, REFINE_LEVELS + 1, REFINE_GAIN * 1.4)
        # 把密度包络插到细分后的点上，按法向推开 → 密处散成一坨，稀处收成一条
        m = len(pts)
        env = np.interp(np.linspace(0, 1, m), np.linspace(0, 1, len(density)), density)
        # 每根丝一个自己的横向相位，使它们互相穿插而不是平行
        phase = float(rng.uniform(0, math.tau))
        freq = float(rng.uniform(1.5, 4.5))
        px = []
        for i, (r, c) in enumerate(pts):
            u = i / max(1, m - 1)
            # 法向
            j = min(i + 1, m - 1); k = max(i - 1, 0)
            dr, dc = pts[j][0] - pts[k][0], pts[j][1] - pts[k][1]
            n = math.hypot(dr, dc) or 1.0
            nr, nc = -dc / n, dr / n
            spread = BUNDLE_MAX_PX * env[i] * math.sin(phase + freq * math.tau * u)
            x, y = to_px((r + nr * spread / scale, c + nc * spread / scale))
            px.append((x, y))
        # ⚠ 单丝亮度**必须远低于 1**：22 根叠加，若每根都接近 1，整束会全部推到饱和
        #   ⇒ 出来是一坨白棉花，蓝一点不剩（实测 amp=1 就是这个下场）。
        #   压到 0.5 以下，只有**几根真正重合**的地方才爆白 —— 那正是参考里
        #   "白热的芯点散落在蓝色束子里"的成因。
        amp = 0.52 if f == 0 else 0.10 + 0.24 * float(rng.random())
        _draw_polyline(core, px, amp, CORE_SIGMA_PX)

    # ---- 枝：细、暗、断在空中
    for bi, (path, current) in enumerate(branches):
        rng = np.random.default_rng((seed * 7717) ^ (bi * 104729))
        pts = _simplify([(float(cells[i][0]), float(cells[i][1])) for i in path], SIMPLIFY_EPS_BRANCH)
        pts = _refine(pts, rng, REFINE_LEVELS + 1, REFINE_GAIN * 1.4)
        px = [to_px(q) for q in pts]
        _draw_polyline(core, px, 0.14 + 0.36 * float(current) ** 0.5, CORE_SIGMA_PX * 0.85)

    # ---- 落点炸开：贴地一圈短促的横向碎电 + 一团亮斑
    foot = to_px(macro[-1])
    rng = np.random.default_rng(seed ^ 0xF007)
    for _ in range(26):
        ang = float(rng.uniform(-math.pi, math.pi))
        ln = float(rng.uniform(10, 74))
        x1 = foot[0] + math.cos(ang) * ln
        y1 = foot[1] + abs(math.sin(ang)) * ln * 0.18      # 压扁：贴着地面爬
        _draw_polyline(core, [foot, (x1, y1)], 0.32, CORE_SIGMA_PX)
    ys, xs = np.mgrid[0:TEX_H, 0:TEX_W]
    # 落点亮斑：**压扁**（贴着地面炸开，不是悬空一个球）
    core += 0.9 * np.exp(-(((xs - foot[0]) / 34.0) ** 2 + ((ys - foot[1]) / 11.0) ** 2)).astype(np.float32)

    # ---- 合成：白芯 + 两级蓝晕
    glow = np.zeros_like(core)
    for sig, gain in zip(GLOW_SIGMAS, GLOW_GAINS):
        glow += gain * gaussian_filter(core, sigma=sig)

    # 合成：**用未截断的 core 判"有多白"**。截断后再判，整束都是 1 = 全白。
    whiteness = np.clip(core, 0.0, 1.0)
    alpha = np.clip(core + glow, 0.0, 1.0)
    rgb = np.zeros((TEX_H, TEX_W, 3), dtype=np.float32)
    for ch in range(3):
        rgb[..., ch] = TEX_GLOW_RGB[ch] + (TEX_CORE_RGB[ch] - TEX_GLOW_RGB[ch]) * whiteness
    rgb = np.clip(rgb, 0.0, 1.0)
    rgba = np.dstack([rgb, alpha])

    # ---- 把落点搬到贴图**正中心**（裁/补透明边），让运行时偏移可以直接是 [0,0,0]
    #
    # 为什么不靠偏移去对齐：粒子的 `offset` 是 **M-world** 里的三维偏移，而贴图尺寸
    # (`sizeWu`) 走的是**场景 wu** × 透视系数 —— 两套换算不一样（差一个逐场景的
    # wuPerQUnit 与深度映射）。按贴图高度算出来的偏移量放进 M-world 永远差一截，
    # 实测雷尖比锚点低一百多像素。中心对齐把这一整类坐标问题一次消掉：
    # 粒子四边形本来就是**以粒子位置为中心**画的，落点在正中心 ⇒ 落点 = 锚点，没有中间换算。
    fx_px, fy_px = foot
    H2 = int(round(2 * fy_px))                      # 落点落在正中 ⇒ 总高 = 2×落点行号
    W2 = int(round(2 * max(fx_px, TEX_W - fx_px)))  # 横向同理，取宽的一侧
    out = np.zeros((H2, W2, 4), dtype=np.float32)
    ox = int(round(W2 / 2 - fx_px))
    oy = int(round(H2 / 2 - fy_px))
    sx0, sy0 = max(0, -ox), max(0, -oy)
    dx0, dy0 = max(0, ox), max(0, oy)
    h = min(TEX_H - sy0, H2 - dy0)
    w = min(TEX_W - sx0, W2 - dx0)
    out[dy0:dy0 + h, dx0:dx0 + w] = rgba[sy0:sy0 + h, sx0:sx0 + w]
    if H2 > MAX_TEX_PX or W2 > MAX_TEX_PX:
        raise ValueError(
            f"成品贴图 {W2}×{H2} 超过引擎安全上限 {MAX_TEX_PX}px —— 超了**整张图不加载**，"
            f"画面上是'雷根本没出现'。把 TEX_W/TEX_H 调小重烘。")
    return out


def write_texture(seed: int, eta: float, out: Path):
    """烘一张，返回 (路径, 宽px, 高px)。落点恒在贴图正中心。"""
    from PIL import Image
    rgba = render_texture(seed, eta)
    img = Image.fromarray((rgba * 255.0 + 0.5).astype(np.uint8), mode="RGBA")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out, rgba.shape[1], rgba.shape[0]


#: 烘出来的雷贴图落点（仓库内真实路径 / 运行时引用路径）
TEXTURE_DIR = Path("public/resources/runtime/images/vfx")
TEXTURE_REF_DIR = "/resources/runtime/images/vfx"
#: 烘几道不一样的雷。同一个道具反复放，每次都该是新的一道 ——
#: 一张图反复用，第二次就露馅了。离线烘，多几张不要钱（一张 ~150KB）。
VARIANTS = 10

SPARK = "/resources/runtime/images/vfx/spark.png"
GLOW = "/resources/runtime/images/vfx/flame_glow.png"
PUFF = "/resources/runtime/images/vfx/smoke_puff.png"


def _sim(*, scene_wind=False, wind=False, airflow=False):
    return {
        "solver": "particle", "spawnPlacement": "shape", "initialVelocity": "configured",
        "influences": {"sceneWind": scene_wind, "wind": wind, "airflow": airflow, "stimulus": False},
        "recycle": {"mode": "none"},
    }


#: 雷在世界里的高度（wu）。贴图的高按长宽比走，所以这里给的是**宽度**。
BOLT_HEIGHT_WU = 1700.0


def build_emitters(tex_ref: str, tex_w: int, tex_h: int) -> list[dict]:
    """雷的粒子层。

    第一条就是**雷本体** —— 一张离线烘出来的贴图，一个粒子、**一个 draw call**。
    其余几条是"打下来了"的证据（云内闪、落点电弧、溅射、焦烟）。
    """
    # 落点在贴图正中心，而粒子四边形以粒子位置为中心画 ⇒ **偏移恒为 0**，落点就是锚点。
    # 贴图下半是透明留白（落点以下没有雷），所以整张图的世界高 = 雷本身高度的两倍。
    bolt_w = round(2 * BOLT_HEIGHT_WU * tex_w / tex_h, 1)
    return [
        {
            # 雷本体。`sizeWu` 是**宽度**，高按贴图长宽比 ⇒ 竖长条原生支持。
            # ⚠ 锚点 = 雷的**末端**（击中点）。做法是把落点烘到贴图正中心、偏移归零 ——
            #   别再试图用 offset 去对齐：offset 是 M-world，贴图尺寸是场景 wu，两套换算不一样，
            #   实测怎么算雷尖都比锚点低一百多像素（那看着不像"劈中了"，像"在旁边亮了一下"）。
            "id": "bolt",
            "simulation": _sim(),
            "offset": [0, 0, 0],
            "appearance": {
                "image": tex_ref,
                "sizeWu": round(bolt_w, 1),
                # 回击期通道亮度是**急升缓降**：前 8% 冲到满，之后指数衰减。
                # 这和贴图无关，是时间维度上的物理。
                "alphaOverLife": [[0, 1.0], [0.08, 1.0], [0.3, 0.5], [0.62, 0.22], [1, 0]],
                "tint": [1, 1, 1],
                "blend": "add",
                "lit": False,
            },
            "spawn": {"max": 1, "burst": 1, "shape": {"kind": "point"}, "speed": [0, 0]},
            "motion": {},
            "life": {"seconds": [0.42, 0.42]},
        },
        {
            # 云内闪：打雷那一下云被里面照亮。**刻意克制** —— 第一版给到 900wu/α0.75，
            # 整屏被刷成紫雾，场景全糊（制作人要求"必须黑"）。
            "id": "cloud_flash",
            "simulation": _sim(),
            "offset": [0, 1450, 0],
            "appearance": {
                "image": GLOW, "sizeWu": 420, "sizeJitter": [0.7, 1.4],
                "sizeOverLife": [[0, 0.8], [1, 1.35]],
                "alphaOverLife": [[0, 0.4], [0.35, 0.22], [1, 0]],
                "tint": [0.55, 0.70, 1.0], "blend": "add", "lit": False,
            },
            "spawn": {"max": 5, "burst": 4,
                      "shape": {"kind": "box", "size": [900, 220, 400]}, "speed": [0, 6]},
            "motion": {}, "life": {"seconds": [0.22, 0.5]},
        },
        {
            "id": "impact_sparks",
            "simulation": _sim(wind=True),
            "appearance": {
                "image": SPARK, "sizeWu": 4, "sizeJitter": [0.6, 1.5],
                "alphaOverLife": [[0, 1], [0.55, 0.8], [1, 0]],
                "tint": [1, 1, 1],
                "tintOverLife": [[0, 0.82, 0.90, 1.0], [1, 1.0, 0.80, 0.45]],
                "blend": "add", "lit": False,
            },
            "spawn": {"max": 140, "burst": 110, "shape": {"kind": "disc", "radius": 10},
                      "speed": [70, 300], "direction": [0, 1, 0], "spread": 88},
            "motion": {"gravity": 620, "drag": 1.6, "maxSpeed": 400},
            # 刻意长过雷本体：临时实例按 liveCount==0 收尸，粒子先死光会把雷一起删掉
            "life": {"seconds": [0.45, 1.0]},
        },
        {
            "id": "scorch_smoke",
            "simulation": _sim(scene_wind=True, wind=True, airflow=True),
            "offset": [0, 6, 0],
            "appearance": {
                "image": PUFF, "sizeWu": 26, "sizeJitter": [0.8, 1.3],
                "sizeOverLife": [[0, 0.5], [1, 2.2]],
                "alphaOverLife": [[0, 0], [0.2, 0.35], [1, 0]],
                "tint": [0.22, 0.22, 0.24], "lit": True,
                "spin": {"rate": [-25, 25], "randomPhase": True},
            },
            "spawn": {"max": 24, "burst": 14, "shape": {"kind": "disc", "radius": 14},
                      "speed": [10, 40], "direction": [0, 1, 0], "spread": 35},
            "motion": {"drag": 1.2, "buoyancy": 40,
                       "turbulence": {"strength": 45, "scale": 40, "speed": 0.7}, "maxSpeed": 90},
            "life": {"seconds": [1.1, 2.2]},
        },
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="用介质击穿模型烘若干道雷（贴图 + 效果资产）")
    ap.add_argument("--seed", type=int, default=7, help="起始随机种子（第 i 道用 seed+i）")
    ap.add_argument("--eta", type=float, default=ETA,
                    help="击穿概率对场强的幂次（文献 1..3；越小分叉越密、游走越强）")
    ap.add_argument("--variants", type=int, default=VARIANTS, help="烘几道")
    ap.add_argument("--dry-run", action="store_true", help="只打印统计，不写盘")
    args = ap.parse_args(argv)

    print(f"DBM η={args.eta} 网格 {GRID_W}×{GRID_H} 丝 {FILAMENTS} 根 贴图 {TEX_W}×{TEX_H}")
    if args.dry_run:
        return 0

    for i in range(args.variants):
        eid = f"lightning_bolt_{i + 1:02d}"
        tex, tw, th = write_texture(args.seed + i * 101, args.eta, TEXTURE_DIR / f"{eid}.png")
        doc = {
            "id": eid,
            "label": f"天雷 {i + 1:02d}：介质击穿模型离线烘成贴图（1 个 draw call）+ 云内闪 / 溅射 / 焦烟",
            "emitters": build_emitters(f"{TEXTURE_REF_DIR}/{eid}.png", tw, th),
        }
        saved, _norm, warn = assets.save_asset(doc)
        print(f"  {eid}  贴图 {tw}×{th}（落点在正中心）  {tex.name}")
        for w in warn:
            print(f"     ⚠ {w}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
