"""蒙特卡洛烘焙的契约:tracer / 采样器 / 估计器 / 逃逸辐射 / probe 分布。

2026-09-01 随 probe + skyao 换算法一起加。这里钉的都是**可证伪的解析判据**,
不是「跑起来不报错」——被替换掉的旧实现也跑得起来、也不报错,它只是算错。
"""
from __future__ import annotations

import inspect
import math
import sys
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.character_lighting_lab import escape as ESC             # noqa: E402
from tools.character_lighting_lab.estimators import (               # noqa: E402
    AK, cap0, gather_probe, octa_bin_normals, probe_eval_bins, probe_eval_sh,
    sh_basis, sky_moments, sky_vis_of_normal, vis_of_dir)
from tools.character_lighting_lab.probe_layout import (             # noqa: E402
    build_layout, dilate_invalid, grid_points)
from tools.character_lighting_lab.sampling import (                 # noqa: E402
    point_keys, uniform_sphere, uniform_upper_hemisphere)
from tools.character_lighting_lab.trace import DepthField, trace    # noqa: E402

I3 = np.eye(3, dtype=np.float32)


def _open_field() -> tuple[DepthField, np.ndarray]:
    """全逃逸构造:深度场恒 5.0,起点 qz=0 远在 d_min 之下 ⇒ 终止 3 立即逃逸。
    这是「完全无遮挡」的精确实现,可以拿解析真值卡。"""
    depth = np.full((64, 128), 5.0, np.float32)
    field = DepthField.build(depth, ppu=20.0, cx=64.0, cy=32.0)
    pts = np.zeros((256, 3), np.float32)
    pts[:, 0] = np.linspace(-1, 1, 256)       # 位置各不相同 ⇒ 检验位置哈希
    return field, pts


# =============================================================== tracer

def test_tracer没有任何射程参数():
    """制作人 2026-09-01 铁令:所有 trace 的射线都无限长,不准钳制长度。

    把射程做成参数,它迟早会被人传一个「够用的」值,然后 tracer 就开始
    **静默编造遮蔽** —— 旧实现射程 2.2 wu、场景宽 4.5 wu,街对面整排房子
    一根射线都挡不住,而画面上只是"有点太亮"。
    结构上不给这个口子,比写注释求人别用可靠。
    """
    sig = inspect.signature(trace)
    assert list(sig.parameters) == ['origins_q', 'dirs_q', 'field'], sig
    src = (Path(_ROOT) / 'tools/character_lighting_lab/trace.py').read_text('utf-8')
    for banned in ('max_distance', 'max_steps'):
        assert banned not in src.replace('没有射程参数', ''), f'trace.py 又出现了 {banned}'


def test_出画就是逃逸():
    """三条终止全精确,没有「跑 N 步就停」。朝画外的射线必须逃逸而不是命中。"""
    field, _ = _open_field()
    o = np.zeros((3, 3), np.float32)
    d = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0]], np.float32)
    r = trace(o, d, field)
    assert r.escaped.all(), r.escaped
    assert (r.hit_yx == -1).all()
    assert np.isinf(r.t_hit).all()


def test_同一批射线重跑逐位相同():
    """字节可复现是本 baker 的铁律(`test_烘出来的场与光照参数无关` 依赖它):
    并行归约、线程调度、批次划分都不许影响结果。"""
    field, pts = _open_field()
    a0, a1 = sky_moments(pts, I3, field, spp=32)
    b0, b1 = sky_moments(pts, I3, field, spp=32)
    assert np.array_equal(a0, b0) and np.array_equal(a1, b1)


def test_位置哈希让结果与批次划分无关():
    """种子按**空间位置**派生,不按数组下标 —— 分两批算与一次算必须逐位相同。
    没有这条,probe 的活格子集(剔掉被埋格)就会和全量算出不同的值。"""
    field, pts = _open_field()
    full0, full1 = sky_moments(pts, I3, field, spp=32)
    h = len(pts) // 2
    lo0, lo1 = sky_moments(np.ascontiguousarray(pts[:h]), I3, field, spp=32)
    hi0, hi1 = sky_moments(np.ascontiguousarray(pts[h:]), I3, field, spp=32)
    assert np.array_equal(full0, np.concatenate([lo0, hi0]))
    assert np.array_equal(full1, np.concatenate([lo1, hi1]))


# ========================================================= 天穹遮蔽矩

def test_无遮挡时矩命中解析值():
    """vis 恒 1 ⇒ a0 = 1/2、a1 = (0, 1/2, 0)。构造性自检,不是拟合出来的。"""
    field, pts = _open_field()
    a0, a1 = sky_moments(pts, I3, field, spp=64)
    assert abs(float(a0.mean()) - 0.5) < 2e-3, a0.mean()
    assert np.abs(a1.mean(0) - np.array([0, 0.5, 0])) .max() < 3e-3, a1.mean(0)


@pytest.mark.parametrize('beta_deg, truth, old', [
    (0.0, 1.0000, 1.0000),      # 朝上:开阔地面
    (90.0, 0.5000, 0.3575),     # 竖直墙面 —— 旧实现偏低 28.5%
    (60.0, 0.7500, 0.6088),
    (30.0, 0.9330, 0.8704),
])
def test_无遮挡时天穹可见度命中解析真值(beta_deg, truth, old):
    """倾斜面的天空视角系数解析真值是 `(1+cos b)/2`。

    旧实现拿 12 条定向射线(仰角只有 28/58 度)做求积,而且**分子乘 (N.w)+、
    分母除 sum (w.up)+** —— 两个不同的积分相除。完全无遮挡的竖直墙面因此
    只给到 0.3575,偏低 28.5%,运行时 `albedo = 原画 / sDay` 把所有竖直面的
    反照率虚高 1.4 倍,灯一打墙就相对地面炸掉。
    """
    field, pts = _open_field()
    a0, a1 = sky_moments(pts, I3, field, spp=64)
    b = math.radians(beta_deg)
    N = np.tile(np.array([math.sin(b), math.cos(b), 0.0], np.float32), (len(pts), 1))
    got = float(sky_vis_of_normal(a0, a1, N).mean())
    assert abs(got - truth) < 5e-3, f'{got:.4f} != {truth}'
    assert abs(got - truth) < abs(old - truth) or truth == old, '没比旧实现更准'


def test_没有方位起伏():
    """旧实现 6 个方位采样点在竖直墙面上留下 15.5% 的 6 次对称指纹
    (曲面上就是六瓣带)。无偏 MC 不该有这个。"""
    field, pts = _open_field()
    a0, a1 = sky_moments(pts, I3, field, spp=64)
    vals = []
    for az in range(0, 360, 5):
        a = math.radians(az)
        N = np.tile(np.array([math.sin(a), 0.0, math.cos(a)], np.float32), (len(pts), 1))
        vals.append(float(sky_vis_of_normal(a0, a1, N).mean()))
    ripple = max(vals) / max(min(vals), 1e-9) - 1
    assert ripple < 0.02, f'方位起伏 {ripple*100:.1f}%(旧实现 15.5%)'


def test_可见度不许超过朝向允许的上限():
    """`T(N)` 是余弦加权可见度的 L1 截断,各向异性遮蔽下会**过冲**。
    实测真实场景 1.8%(雾津街头)~9.1%(义庄)的像素越过 `cap0(N)=(1+N.up)/2`
    ——「这个面看到的天超过了它朝向在完全无遮挡时的物理上限」,不可能。"""
    rng = np.random.default_rng(7)
    N = rng.normal(size=(4096, 3)).astype(np.float32)
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    a0 = rng.uniform(0, 0.5, 4096).astype(np.float32)
    a1 = (rng.normal(size=(4096, 3)) * 0.3).astype(np.float32)
    v = sky_vis_of_normal(a0, a1, N)
    assert (v <= cap0(N) + 1e-6).all()
    assert (v >= 0).all()


def test_定向可见度在无遮挡时恒为1():
    """`vis ≡ 1 ⇒ a0=1/2, a1y=1/2 ⇒ alpha=1, beta=0 ⇒ V_dir ≡ 1`,代入即验。"""
    a0 = np.full(64, 0.5, np.float32)
    a1 = np.tile(np.array([0, 0.5, 0], np.float32), (64, 1))
    for d in ([0, 1, 0], [1, 0, 0], [0.6, 0.8, 0], [0, -1, 0]):
        v = vis_of_dir(a0, a1, np.asarray(d, np.float32))
        assert np.allclose(v, 1.0, atol=1e-5), (d, v[:3])


# ================================================= probe 的方向基与量纲

def _isotropic_coeffs():
    """各向同性 L=1 的 bins / SH 系数,用高密度求积精确构造(不含 MC 噪声)。"""
    D = 200_000
    i = np.arange(D) + 0.5
    phi = math.pi * (3 - math.sqrt(5)) * i
    z = 1 - 2 * i / D
    r = np.sqrt(np.maximum(0, 1 - z * z))
    w = np.stack([r * np.cos(phi), r * np.sin(phi), z], -1).astype(np.float32)
    L = np.ones((D, 3), np.float64)
    inv_pdf = 4 * math.pi
    bins = (np.maximum(w @ octa_bin_normals().T, 0.0).T @ L) * inv_pdf / D
    sh = (sh_basis(w).astype(np.float64).T @ L) * inv_pdf / D * AK[:, None]
    return bins.astype(np.float32), sh.astype(np.float32)


@pytest.mark.parametrize('basis', ['sh', 'bins'])
def test_各向同性下重建出pi(basis):
    """`L ≡ 1 ⇒ E(n) = ∫ max(n.w,0) dw = pi`,与 n 无关。

    ⚠ 这条同时钉住**量纲约定**:probe 图集存的 E **不除 pi**
    (A_l 已卷进系数,着色器只做 `sum coeff*Y`)。少乘/多乘一个 pi,
    parity 会稳定差 3.14 倍 —— 而 3.14 倍很容易被某个增益吸收掉,
    于是「看起来差不多」而实际上错着。
    """
    bins, sh = _isotropic_coeffs()
    rng = np.random.default_rng(3)
    n = rng.normal(size=(4096, 3)).astype(np.float32)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    if basis == 'sh':
        e = probe_eval_sh(np.repeat(sh[None], len(n), 0), n)
    else:
        e = probe_eval_bins(np.repeat(bins[None], len(n), 0), n)
    assert np.abs(e[:, 0] - math.pi).max() < 1e-3, (e.min(), e.max())


def test_八面体编解码与着色器口径一致():
    """`octa_bin_normals` 必须是着色器 `octaEnc` 的**逆**:
    取第 j 个 bin 的法线去重建,应当恰好取回第 j 个系数(插值权重退化成 1)。"""
    nb = octa_bin_normals()
    coeff = np.zeros((len(nb), len(nb), 3), np.float32)
    for j in range(len(nb)):
        coeff[j, j] = 1.0                       # 第 j 颗 probe 只有第 j 个 bin 有值
    got = probe_eval_bins(coeff, nb)[:, 0]
    assert np.abs(got - 1.0).max() < 1e-5, got


# ================================================ 逃逸辐射 / probe 分布

def test_逃逸辐射缺省纯黑():
    """制作人 2026-09-01:「默认就是黑色纯色」。"""
    s = ESC.make_escape_sampler()
    d = np.array([[0, 1, 0], [1, 0, 0]], np.float32)
    assert np.allclose(s(d), 0.0)
    assert hasattr(s, 'constant_rgb')          # 常色快路的标记


def test_逃逸辐射不许从画面上偷偷取值():
    """`scene_derived` 必须是**显式**选项。历史上 `estimate_sky_radiance` 拿
    `depth > p92` 的均值当天空,而室内那 8% 是后墙脚的地面(实测亮度与其余
    毫无区别)。缺省绝不能是它。"""
    assert ESC.DEFAULT_ESCAPE == {'mode': 'black'}
    with pytest.raises(ValueError):
        ESC.make_escape_sampler({'mode': 'scene_derived'})     # 缺 hdr/depth ⇒ 硬错
    assert '慎用' in ESC.describe({'mode': 'scene_derived'})


def test_横纵密度必须解耦():
    """制作人 2026-09-01:「纵向 2 格够了,水平上的分辨率不够,必须提起来」。

    旧写法 `cells_per_char_y = cells_per_char_xz * 2` 把两者焊死 —— 一提水平,
    纵向跟着涨,而纵向那几层**最不缺**(盒高只有 2 个角色高)。
    判据:动一个,另一个必须**一格不动**。
    """
    rng = np.random.default_rng(1)
    world = rng.uniform(-1, 1, (5000, 3)).astype(np.float32)
    base = build_layout('uniform_grid', world, 0.2, cells_per_char_xz=2.0,
                        cells_per_char_y=2.0)
    wide = build_layout('uniform_grid', world, 0.2, cells_per_char_xz=6.0,
                        cells_per_char_y=2.0)
    tall = build_layout('uniform_grid', world, 0.2, cells_per_char_xz=2.0,
                        cells_per_char_y=6.0)
    assert wide.grid[1] == base.grid[1], f'提水平把纵向也拉了:{base.grid} -> {wide.grid}'
    assert wide.grid[0] > base.grid[0] * 2.5 and wide.grid[2] > base.grid[2] * 2.5
    assert (tall.grid[0], tall.grid[2]) == (base.grid[0], base.grid[2]),         f'提纵向把水平也拉了:{base.grid} -> {tall.grid}'
    assert tall.grid[1] > base.grid[1] * 2.5


def test_盒高_地面起伏加角色若干倍_且不跟画面最高点走():
    """制作人 2026-09-01(两步定下来的):

    - 先说「probe 总高度不应该覆盖全场景最高点,只覆盖角色身高的 2 倍即可」;
    - 实测 bridge_underpass 地面起伏 0.374 wu 已经超过「角色 0.170x2 = 0.341」,
      站在高处地面的角色整个人落到盒外 —— 于是改成 **地面起伏 + 角色x2**。

    两条都要成立:
    1. 盒高随 `height_chars` 线性长(角色那一项确实在里面);
    2. 场景里多一根很高的柱子(**只占少数点**,在地面带之上),盒高几乎不动 ——
       上界跟的是**地面**,不是画面最高点。
    """
    rng = np.random.default_rng(4)
    ground = rng.uniform(-1, 1, (5000, 3)).astype(np.float32)
    pillar = np.column_stack([np.zeros(200, np.float32),
                              np.linspace(1.2, 40, 200, dtype=np.float32),
                              np.zeros(200, np.float32)]).astype(np.float32)
    tall = np.concatenate([ground, pillar]).astype(np.float32)
    ch = 0.17
    h2 = build_layout('uniform_grid', ground, ch, height_chars=2.0)
    h4 = build_layout('uniform_grid', ground, ch, height_chars=4.0)
    box2 = h2.bounds['y1'] - h2.bounds['y0']
    box4 = h4.bounds['y1'] - h4.bounds['y0']
    # 多给 2 个角色高,盒高就多 2 个角色高(其余项没变)
    assert abs((box4 - box2) - 2.0 * ch) < 1e-5, (box2, box4)
    # 柱子高到 40 wu,盒高不许跟着飞
    t2 = build_layout('uniform_grid', tall, ch, height_chars=2.0)
    boxt = t2.bounds['y1'] - t2.bounds['y0']
    assert boxt < box2 + 0.15, f'盒高被画面最高点带飞了:{box2:.3f} -> {boxt:.3f}'


def test_地面起伏大的场景不许把角色钳在盒外():
    """`bridge_underpass` 那一类:地面起伏比「角色x2」还大。
    盒顶必须仍然罩住「站在地面带顶的人的头顶」,否则上半身落到网格外被钳到顶层。"""
    rng = np.random.default_rng(9)
    # 起伏 0.8 wu 的地面,角色只有 0.17 —— 起伏远大于 角色x2=0.34
    world = rng.uniform(-1, 1, (5000, 3)).astype(np.float32)
    world[:, 1] = rng.uniform(0.0, 0.8, 5000).astype(np.float32)
    ch = 0.17
    lay = build_layout('uniform_grid', world, ch, height_chars=2.0)
    py = world[:, 1]
    band_top = float(np.percentile(py, 60))       # reachable_box 用 P60 当地面带顶
    head = band_top + ch                          # 站在带顶的人的头顶
    assert lay.bounds['y1'] >= head - 1e-6,         f'盒顶 {lay.bounds["y1"]:.3f} < 头顶 {head:.3f} —— 上半身会被钳到顶层'
    assert lay.bounds['y0'] <= float(np.percentile(py, 2)) + 1e-6


def test_显式格数仍然可以指定():
    """`dims` 是给 A/B 与复现旧载荷用的旁路,不能被密度推导挤掉。"""
    rng = np.random.default_rng(1)
    world = rng.uniform(-1, 1, (5000, 3)).astype(np.float32)
    fixed = build_layout('uniform_grid', world, 0.2, dims=(20, 6, 14))
    assert fixed.grid == (20, 6, 14) and fixed.count == 20 * 6 * 14


def test_旧分布把竖直分辨率浪费在角色够不着的空中():
    """`legacy_fixed` 只为 A/B 保留。它的病:band 写死 1.6 wu(建立在「角色高
    1.5 wu」的假设上),而**实测角色 0.17~0.97 wu**,盒顶因此远高过人的头顶。

    新盒 = 地面起伏 + 角色 x height_chars。收紧多少**取决于场景的地面起伏**:

    - 本用例的合成点云是均匀立方体,「地面起伏」高达 1.16 wu(远大于真实场景),
      盒子被起伏主导 ⇒ 只收紧约 1.9 倍。这是**下界**,断言按它写。
    - 真实场景起伏小得多(雾津街头 0.121 wu),盒高 1.787 -> 约 0.47,收紧约 3.8 倍。
      别把真实场景那个倍数写死进来,换个 fixture 就挂。
    """
    rng = np.random.default_rng(2)
    world = rng.uniform(-1, 1, (5000, 3)).astype(np.float32)
    char_wu = 0.17                                  # 雾津街头实测
    old = build_layout('legacy_fixed', world, char_wu)
    new = build_layout('uniform_grid', world, char_wu, dims=(20, 6, 14))
    old_layers = char_wu / old.cell_size()[1]
    new_layers = char_wu / new.cell_size()[1]
    assert old_layers < 0.4, old_layers              # 整个人挤在小半层里
    assert new_layers > old_layers * 1.7, (old_layers, new_layers)
    assert old.params['band'] == 1.6                 # 旧值原样留着,供 A/B
    assert old.count == new.count                    # 载荷大小一字不变,只是盒收紧了


# ============================================ stage_probes 的接线契约

def _fake_scene(w=48, h=32, ppu=16.0):
    """能喂给 stage_probes 的最小 cal/lay/hdr。不跑深度模型、不跑 SAM3。"""
    import math as _m
    sy = np.arange(h, dtype=np.float32)[:, None]
    qy = (h / 2.0 - sy) / ppu
    d = np.broadcast_to(qy + 2.0, (h, w)).astype(np.float32).copy()
    d[6:16, 14:26] = 1.5                       # 站在地面上的一堵墙
    c = s = 0.7071067811865476
    cal = {'d': d, 'ppu': ppu, 'cx': w / 2.0, 'cy': h / 2.0, 'theta': _m.pi / 4,
           'qy': np.broadcast_to(qy, (h, w)).astype(np.float32)}
    lay = {'d_walk': np.broadcast_to(qy + 2.0, (h, w)).astype(np.float32).copy()}
    rng = np.random.default_rng(11)
    hdr = {'base': rng.uniform(0.02, 0.4, (h, w, 3)).astype(np.float32),
           'emit': np.zeros((h, w, 3), np.float32)}
    hdr['emit'][8:10, 18:20] = 6.0             # 一小片发光体,喂 NEE 分账
    M = np.array([[1, 0, 0], [0, c, -s], [0, -s, -c]], np.float32)
    q_ground = np.stack([np.broadcast_to((np.arange(w, dtype=np.float32) - w / 2) / ppu, (h, w)),
                         cal['qy'], lay['d_walk']], -1).reshape(-1, 3)
    Xg = q_ground @ M.T
    wb = {'M': M,
          'x0': float(Xg[:, 0].min()), 'x1': float(Xg[:, 0].max()),
          'y0': float(np.percentile(Xg[:, 1], 2)) - 0.02,
          'y1': float(np.percentile(Xg[:, 1], 60)) + 0.25,
          'z0': float(Xg[:, 2].min()), 'z1': float(Xg[:, 2].max())}
    return cal, lay, hdr, wb


#: `export_runtime._read_probe` 会把每个文件 reshape 成 (P, K, ch)。
#: 形状对不上就是**运行时读到错位的图集**——不报错,画面上"光乱跳"。
_PAYLOAD_SHAPE = {
    'l1': (4, 4), 'l2': (9, 4), 'bins': (64, 4),
    'l1amb': (4, 3), 'l2amb': (9, 3), 'binsamb': (64, 3),
    'l1emit': (4, 3), 'l2emit': (9, 3), 'binsemit': (64, 3),
    'l1nee': (4, 3), 'l2nee': (9, 3), 'binsnee': (64, 3),
}


def test_stage_probes的载荷形式一字未变():
    """本次只换算法、**不动形式**:20 项 f16 图集 + valid + world_pos,
    形状与 dtype 必须与 `build()` 的写盘和 `export_runtime._read_probe` 逐项吻合。
    """
    from tools.character_lighting_lab.pipeline import stage_ambient, stage_probes
    cal, lay, hdr, wb = _fake_scene()
    P = {'probe_strategy': 'uniform_grid', 'probe_dims': (8, 5, 6),
         'probe_spp': 32, 'probe_max': 200_000, 'escape': {'mode': 'black'}}
    esc = ESC.make_escape_sampler(P['escape'])
    lights = [{'pos': [0.1, 0.0, 0.2], 'normal': [0, 1, 0],
               'radiance': [3.0, 2.0, 1.0], 'area': 0.01, 'power': 0.03}]
    pr = stage_probes(cal, lay, hdr, wb, lights, P, esc, char_wu=0.22)

    n = 8 * 5 * 6
    assert (pr['nx'], pr['ny'], pr['nz']) == (8, 5, 6)
    assert pr['valid'].shape == (n,) and pr['valid'].dtype == bool
    assert pr['world_pos'].shape == (n, 3) and pr['world_pos'].dtype == np.float32
    for axis, cnt in (('gx', 8), ('gy', 5), ('gz', 6)):
        assert len(pr[axis]) == cnt
    for k, (K, ch) in _PAYLOAD_SHAPE.items():
        a = pr[k]
        assert a.dtype == np.float16, (k, a.dtype)
        assert a.shape == (n, K, ch), (k, a.shape, (n, K, ch))
        # export_runtime 就是这么 reshape 的:字节数对不上会静默错位
        assert np.frombuffer(a.tobytes(), np.float16).size == n * K * ch
    assert np.isfinite(pr['l2'].astype(np.float32)).all(), 'probe 图集出现了 nan/inf'

    amb = stage_ambient(esc, P)
    assert amb['sh'].shape == (9, 3)
    assert np.allclose(amb['sh'], 0.0), '逃逸辐射纯黑时 ambient SH 必须是 0'


def test_被埋的probe被邻居填过而不是留着精确的0():
    """删掉 fold 之后,埋在墙里的 probe 拿到的是**精确的 0**(它确实什么都看不见)。
    不 dilate 就会被三线性借给邻格,把贴墙的角色压暗。

    ⚠ 两个前提第一版都写错了,记在这免得再踩:

    1. 逃逸辐射给纯黑时这条测不出东西 —— 射线跑出画外的**开阔** probe 也是 0,
       那是合法结果,和「埋在墙里没被填」混在一起分不开。给白色才分得开。
    2. `l2` 只装 **base 分账**,逃逸辐射在 `l2amb`,两者要到
       `export_runtime._atlas4` 才合成 `base + emit + amb*w`。
       只看 `l2` 会稳定看到一批合法的 0(开阔 probe 的 base 本来就是 0)。
       判据必须落在**合成后**的 E 上 —— 那才是运行时真正查的东西。
    """
    from tools.character_lighting_lab.pipeline import stage_probes
    cal, lay, hdr, wb = _fake_scene()
    P = {'probe_strategy': 'uniform_grid', 'probe_dims': (10, 6, 8),
         'probe_spp': 32, 'probe_max': 200_000,
         'escape': {'mode': 'color', 'color': [1.0, 1.0, 1.0]}}
    pr = stage_probes(cal, lay, hdr, wb, [],
                      P, ESC.make_escape_sampler(P['escape']), char_wu=0.22)
    assert pr['coverage'] < 1.0, '这个构造里本该有埋在墙里的 probe'
    assert pr['valid'].all(), 'dilation 没把 invalid 填满'
    # 与 export_runtime._atlas4 同一句:base + (nee 关时用 emit) + amb*1.0
    final = (pr['l2'].astype(np.float32)[:, :, :3]
             + pr['l2emit'].astype(np.float32) + pr['l2amb'].astype(np.float32))
    lum = final[:, 0, :].sum(1)
    assert (lum > 0).all(), f'仍有 {(lum <= 0).mean()*100:.0f}% 的 probe 合成后是全 0'
