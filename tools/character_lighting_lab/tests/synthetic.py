"""合成场景脚手架:一张渐变背景 + 线性深度斜坡 + 45 度标定,落在 tmp_path 里。

**唯一一份**。几何(`scene_geometry`)与几何场烘焙(`scene_fields`)的测试用它,
下游的重打光工具(`tools/scene_relight`)测试也用它 —— 那边曾各自抄一份,
而合成场景的形状就是几何契约本身,抄两份等于两个真相源。

用法:

    from tools.character_lighting_lab.tests.synthetic import make_scene, patch_roots

    @pytest.fixture
    def town(tmp_path, monkeypatch):
        patch_roots(monkeypatch, tmp_path)
        make_scene(tmp_path)
        return tmp_path
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

#: 合成图尺寸。刻意不是方的,轴写反了才抓得住。
W, H = 64, 40


def _depth_wall() -> np.ndarray:
    """缺省形状:线性深度斜坡。

    ⚠ **它在世界系里是一面墙,不是地面**(2026-09-01 查明)。
    45 度标定下 ``world_z = s*(qy + qz)``,而这个斜坡恰好让 ``qy + qz`` 近似常数
    ⇒ 整张图的 world_z 只跨 0.035 wu,world_y 跨 2.8 wu。
    也就是说它是一块**竖直平板**。

    几何/标定/落点类断言不受影响(那些只关心刻度链与文件),但任何
    「越高看见的天越多」这类**空间**判据在它上面不成立 —— 墙上方的点
    会直接埋进几何里。要那种判据请用 ``shape='ground'``。
    """
    return np.linspace(0.5, 2.5, H, dtype=np.float32)[:, None].repeat(W, 1)


def _depth_ground() -> np.ndarray:
    """真地面 + 一堵挡光墙:``world_y`` 恒定的水平面,中间立一块竖直遮挡。

    45 度标定下水平面(world_y = 常数)要求 ``qz = qy + 常数``;
    取常数 2.0 ⇒ 深度 1.05(近,画面下沿)~ 3.0(远,画面上沿),全正。

    再在中段扣一块**恒定深度**的区域 = 一面朝相机的竖直墙,站在地面上。
    有了它「越高看见的天越多」才是真的:贴地的点被墙挡住大半个上半球,
    越往上越绕得过去。没有遮挡物的无限平面,天穹可见度与高度**无关**
    (平面永远挡掉同样的立体角),那种 fixture 测不出单调性。
    """
    sy = np.arange(H, dtype=np.float32)[:, None]
    qy = (H / 2.0 - sy) / 20.0
    d = np.broadcast_to(qy + 2.0, (H, W)).copy()
    d[8:26, 24:40] = 1.35            # 立在地面上的一堵墙(恒定深度 = 竖直面)
    return d


def make_scene(tmp: Path, sid: str = 'testtown', with_depth: bool = True,
               with_mask: bool = False, shape: str = 'wall') -> None:
    """合成一个最小场景:渐变背景 + 深度场 + 45 度标定。

    ``worldWidth`` 是刻度链的一环:场景坐标 →(native_w/worldWidth)→ 背景像素
    →(1/ppu)→ 世界单位。这里取 640 / 64 / 20 ⇒ scene_per_wu = 200。

    ``shape``:``'wall'``(缺省,与 2026-09-01 之前逐字节相同的线性斜坡 ——
    但它在世界系里其实是竖直平板,见 ``_depth_wall``)或 ``'ground'``
    (真水平地面 + 一堵挡光墙,空间判据用这个)。
    """
    (tmp / 'assets').mkdir(parents=True, exist_ok=True)
    rt = tmp / 'rt' / sid
    rt.mkdir(parents=True, exist_ok=True)
    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[..., 0] = np.linspace(40, 200, W, dtype=np.uint8)[None, :]
    rgb[..., 1] = 128
    rgb[..., 2] = np.linspace(200, 60, H, dtype=np.uint8)[:, None]
    Image.fromarray(rgb).save(rt / 'background.png')
    data: dict = {'id': sid, 'worldWidth': 640.0, 'worldHeight': 400.0,
                  'backgrounds': [{'image': 'background.png', 'x': 0, 'y': 0}]}
    if with_depth:
        d = _depth_ground() if shape == 'ground' else _depth_wall()
        lo, hi = float(d.min()) - 1e-4, float(d.max()) + 1e-4
        raw16 = np.round((d - lo) / (hi - lo) * 65535).astype(np.uint16)
        rg = np.zeros((H, W, 3), np.uint8)
        rg[..., 0] = raw16 >> 8
        rg[..., 1] = raw16 & 0xFF
        Image.fromarray(rg).save(rt / 'raw_depth_rg.png')
        c = s = 0.7071067811865476
        data['depthConfig'] = {
            'depth_map': 'raw_depth_rg.png',
            'M': {'R': [[1, 0, 0], [0, c, -s], [0, s, c]], 'ppu': 20.0,
                  'cx': W / 2.0, 'cy': H / 2.0},
            'depth_mapping': {'invert': False, 'scale': hi - lo, 'offset': lo},
        }
    if with_mask:
        m = np.zeros((H, W), np.uint8)
        m[18:22, 30:34] = 255
        out = tmp / 'out' / sid
        out.mkdir(parents=True, exist_ok=True)
        Image.fromarray(m).save(out / 'emissive_mask.png')
    (tmp / 'assets' / f'{sid}.json').write_text(
        json.dumps(data, ensure_ascii=False), encoding='utf-8')


def patch_roots(monkeypatch, tmp: Path) -> None:
    """把几何模块(以及重打光工具的工作目录)的路径常量指到临时工程。

    ⚠ 必须打在 **`scene_geometry` 模块本身**上:下游按模块引用它
    (`_geo.SCENES_RT`),按值 import 的话这里打了也不生效。
    """
    from tools.character_lighting_lab import scene_geometry
    monkeypatch.setattr(scene_geometry, 'SCENES_JSON', tmp / 'assets')
    monkeypatch.setattr(scene_geometry, 'SCENES_RT', tmp / 'rt')
    try:
        from tools.scene_relight import workspace
    except ImportError:                              # 只跑实验室测试时下游可以不在
        return
    monkeypatch.setattr(workspace, 'OUT', tmp / 'out')
