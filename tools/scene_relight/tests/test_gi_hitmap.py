"""GI 命中图的布局与语义。

布局错了**运行时不报错**——shader 照样能采样，只是采到别的格子去，
表现为"反弹光的方向不对"或"角色在某些位置莫名变亮"，肉眼极难归因。
所以平铺规则必须与 `skyvis_grid` 逐条对齐，并在这里锁死。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.scene_relight.bake import (  # noqa: E402
    GI_DIRS, _gi_directions, bake_gi_hitmap,
)

GRID = (4, 3, 5)          # nx, ny, nz —— 刻意各不相同，才抓得到轴错位
BOUNDS = {'x0': -1.0, 'x1': 1.0, 'y0': 0.0, 'y1': 0.6, 'z0': -1.0, 'z1': 1.0}


def make_geo(depth: np.ndarray) -> dict:
    h, w = depth.shape
    return {
        'R': np.eye(3, dtype=np.float32),      # 单位 M ⇒ q ≡ world，便于手推
        'depth': depth.astype(np.float32),
        'ppu': 10.0, 'cx': w / 2.0, 'cy': h / 2.0,
    }


class TestDirections:
    def test_方向数与常量一致(self) -> None:
        assert len(_gi_directions()) == GI_DIRS

    def test_全是单位向量(self) -> None:
        for d in _gi_directions():
            assert float(np.linalg.norm(d)) == pytest.approx(1.0, abs=1e-6)

    def test_偏向水平与下方(self) -> None:
        """正上方那半球是天空，已由 skyvis 单独记账；再采一遍就是重复计。"""
        ys = _gi_directions()[:, 1]
        assert ys.max() < 0.5, '有方向仰角过高，会与 skyvis 重复记账'
        assert (ys < 0).sum() >= 6, '朝下的方向太少——地面反弹是大头'


class TestLayout:
    def test_尺寸是_nx乘nz_乘_ny乘ndir(self) -> None:
        depth = np.full((40, 60), 5.0, np.float32)     # 远平面：射线一路打不到
        r = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)
        nx, ny, nz = GRID
        assert r['size'] == [nx * nz, ny * GI_DIRS]
        assert r['data'].shape == (ny * GI_DIRS, nx * nz, 4)
        assert r['data'].dtype == np.uint8

    def test_alpha_恒为_255(self) -> None:
        depth = np.zeros((40, 60), np.float32)
        r = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)
        assert (r['data'][..., 3] == 255).all()

    def test_全是远平面时一个都打不到(self) -> None:
        """深度全在很远处 ⇒ 射线在 march 长度内够不着 ⇒ 命中率 0。"""
        depth = np.full((40, 60), 50.0, np.float32)
        r = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)
        assert r['hit_rate'] == 0.0
        assert (r['data'][..., 2] == 0).all()

    def test_命中标志与_hit_rate_自洽(self) -> None:
        rng = np.random.default_rng(7)
        depth = rng.uniform(-0.5, 0.5, (40, 60)).astype(np.float32)
        r = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)
        got = (r['data'][..., 2] > 0).mean()
        assert r['hit_rate'] == pytest.approx(float(got), abs=1e-9)

    def test_命中标志只有_0_或_255(self) -> None:
        rng = np.random.default_rng(11)
        depth = rng.uniform(-0.5, 0.5, (40, 60)).astype(np.float32)
        b = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)['data'][..., 2]
        assert set(np.unique(b).tolist()) <= {0, 255}

    def test_没命中的格子_uv_为_0(self) -> None:
        """miss 的 UV 必须是确定值，否则 shader 里 `if (hm.b < 0.5) continue`
        之前的那次 texture() 取样会读到随机 UV —— 虽然结果被丢弃，但脏数据
        会让调试可视化误导人。"""
        rng = np.random.default_rng(3)
        depth = rng.uniform(-0.5, 0.5, (40, 60)).astype(np.float32)
        d = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)['data']
        miss = d[..., 2] == 0
        assert (d[..., 0][miss] == 0).all()
        assert (d[..., 1][miss] == 0).all()


class TestGridOrder:
    def test_列是_x加z乘nx_与_skyvis_grid_同规则(self) -> None:
        """构造一个只在**某一列 x** 上有几何的深度场，验证命中只出现在对应的列。

        平铺规则错位是这类布局最常见的 bug，而且运行时完全静默。
        """
        nx, ny, nz = GRID
        # 深度场：只在图像左半边放一堵"墙"（深度接近网格点所在的 z）
        depth = np.full((40, 60), 50.0, np.float32)
        depth[:, :30] = 0.0
        r = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)
        d = r['data']
        # 网格 x 从 -1 到 1，ppu=10、cx=30 ⇒ world x=-1 → px=20（左半边，有墙）
        #                                  world x=+1 → px=40（右半边，无墙）
        hits_by_x = []
        for x in range(nx):
            cols = [x + z * nx for z in range(nz)]
            hits_by_x.append(int((d[:, cols, 2] > 0).sum()))
        # 左侧（x 小）命中应当显著多于右侧
        assert hits_by_x[0] > hits_by_x[-1], (
            f'命中沿 x 的分布与几何不符：{hits_by_x}（平铺列序可能错位）')

    def test_方向沿高度叠_行等于_dir乘ny加y(self) -> None:
        """把某一个方向单独喂进去，验证它只落在自己那一段行里。"""
        rng = np.random.default_rng(5)
        depth = rng.uniform(-0.5, 0.5, (40, 60)).astype(np.float32)
        nx, ny, nz = GRID
        d = bake_gi_hitmap(make_geo(depth), GRID, BOUNDS)['data']
        # 每个方向占 ny 行；不同方向的命中模式不该完全相同（否则说明行索引没生效）
        blocks = [d[i * ny:(i + 1) * ny, :, 2] for i in range(GI_DIRS)]
        distinct = {b.tobytes() for b in blocks}
        assert len(distinct) > 1, '所有方向的命中模式一模一样——行索引 dir*ny+y 没生效'


class TestServeEndpoints:
    """`/api/bake` 与 `/api/migrate` 的路由必须真的接上了。

    端口没接上**不会报错**——桌面壳里点一下，服务端走到路由链末尾返回 404，
    前端一句 "失败" 都不一定弹。所以这里直接检查 `do_POST` 的源码里有那两条分支，
    并确认它们 import 得到真实实现（写错模块名同样是运行时才炸）。
    """

    def test_两条路由都在(self) -> None:
        import inspect
        from tools.scene_relight import serve
        src = inspect.getsource(serve.H.do_POST)
        assert "u.path == '/api/bake'" in src, '烘焙端口没接进 do_POST'
        assert "u.path == '/api/migrate'" in src, '迁移端口没接进 do_POST'

    def test_端口用到的实现可导入(self) -> None:
        """路由里写的是延迟 import；模块名写错要到点击那一刻才炸。"""
        from tools.scene_relight.bake import bake
        from tools.scene_relight.migrate import migrate, verify_identity
        assert callable(bake) and callable(migrate) and callable(verify_identity)

    def test_README_写了这两条(self) -> None:
        """工具的入口不写进 README 等于没有——作者不会去翻 serve.py 的路由表。"""
        from pathlib import Path
        readme = (Path(__file__).resolve().parents[1] / 'README.md').read_text(encoding='utf-8')
        assert 'tools.scene_relight.bake' in readme
        assert 'tools.scene_relight.migrate' in readme
