# -*- coding: utf-8 -*-
"""天穹遮蔽载荷的**数值不变量** —— 拿真实烘焙产物机械地验一遍。

## 这条锁的是什么

`sky_occlusion.png` 存两个量：**bent 方向**（RGB）与**余弦加权可见度**（A）。
遮蔽瘫掉时可见度会退化成处处 1，而画面**看着照常**（默认 `sky.intensity = 0`，
天光那一项本来就不参与）—— 只有这条能看出来。v2 的拟合路正是这样悄悄坏掉的：
28 个场景里 23 个天穹系数被压到 0，而残留指标全程漂亮。

## 为什么不再验"传输 ≤ cap"

因为传输已经不进载荷了。上一版每像素存 4 个纬向通道的传输（把**天空**烤了进去），
角色网格再为同一件事存 4 个 SH-L1 通道 —— 同一个量两种参数化，实测在角色典型
法线处两边差 10%–15%。现在两侧存同一个 `(bent 方向, 可见度)`，天空是运行时的
全局 SH。载荷里能验的就只剩这两个量本身。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_ROOT = Path(__file__).resolve().parents[3]
_SCENES = _ROOT / 'public' / 'resources' / 'runtime' / 'scenes'


def _current_version() -> int:
    src = (_ROOT / 'tools' / 'scene_relight' / 'bake_gbuffer.py').read_text(encoding='utf-8')
    return int(re.search(r'^PAYLOAD_VERSION = (\d+)', src, re.M).group(1))


def _payloads() -> list[Path]:
    """只看**当前代次**的载荷（代次不符的运行时本来就整包忽略）。"""
    if not _SCENES.exists():
        return []
    cur = _current_version()
    out = []
    for p in sorted(_SCENES.glob('*/lighting3/meta.json')):
        try:
            m = json.loads(p.read_text(encoding='utf-8'))
        except Exception:                                  # noqa: BLE001
            continue
        if int(m.get('version', -1)) == cur and (p.parent / 'sky_occlusion.png').exists():
            out.append(p)
    return out


_IDS = [p.parts[-3] for p in _payloads()]


def _load(meta_path: Path):
    px = np.asarray(Image.open(meta_path.parent / 'sky_occlusion.png').convert('RGBA'), np.float32)
    bent = px[..., :3] / 255.0 * 2.0 - 1.0
    vis = px[..., 3] / 255.0
    return bent, vis


@pytest.mark.skipif(not _payloads(), reason='没有当前代次的 lighting3 载荷')
@pytest.mark.parametrize('meta_path', _payloads(), ids=_IDS)
def test_可见度必须有真实落差(meta_path: Path) -> None:
    _bent, vis = _load(meta_path)
    p05 = float(np.percentile(vis, 5))
    assert p05 < 0.92, (f'{meta_path.parts[-3]}: 可见度 p05 = {p05:.3f}，'
                        f'几乎处处看得见天 —— march 很可能没在挡')
    assert float(np.median(vis)) > 0.05, (
        f'{meta_path.parts[-3]}: 可见度中位太低，更像 march 把一切都当成挡住了')
    assert float(vis.max()) > 0.9, f'{meta_path.parts[-3]}: 没有任何开阔处，可疑'


@pytest.mark.skipif(not _payloads(), reason='没有当前代次的 lighting3 载荷')
@pytest.mark.parametrize('meta_path', _payloads(), ids=_IDS)
def test_bent_方向是单位向量且大体朝上(meta_path: Path) -> None:
    """平均未遮挡方向必须归一化，且上半球占绝大多数（天在上面）。"""
    bent, _vis = _load(meta_path)
    ln = np.linalg.norm(bent, axis=-1)
    # 8-bit 量化后长度会在 1 附近抖（每分量步长 1/127.5）
    assert float(np.percentile(np.abs(ln - 1.0), 99)) < 0.02, (
        f'{meta_path.parts[-3]}: bent 方向没归一化，|B| p99 偏差 '
        f'{np.percentile(np.abs(ln - 1.0), 99):.3f}')
    up_frac = float(np.mean(bent[..., 1] > 0))
    assert up_frac > 0.9, (f'{meta_path.parts[-3]}: 只有 {up_frac*100:.1f}% 的 bent 方向朝上 '
                           f'—— 天穹积分只数上半球，朝下说明坐标系拧了')


@pytest.mark.skipif(not _payloads(), reason='没有当前代次的 lighting3 载荷')
@pytest.mark.parametrize('meta_path', _payloads(), ids=_IDS)
def test_载荷布局与代次自洽(meta_path: Path) -> None:
    m = json.loads(meta_path.read_text(encoding='utf-8'))
    assert 'transport' not in m, '4 通道纬向阶梯是被否掉的设计，不该再出现在 meta 里'
    assert m['sky_occlusion']['file'] == 'sky_occlusion.png'
    assert not (meta_path.parent / 'transport.png').exists(), '旧的 transport.png 没清掉'
    ch = m['char_grid']['channels']
    assert ch == ['sky_occlusion_l1', 'local_ao', 'gi_r', 'gi_g', 'gi_b'], ch
    n = m['char_grid']['nx'] * m['char_grid']['ny'] * m['char_grid']['nz']
    assert (meta_path.parent / 'sky_sh_grid.bin').stat().st_size == len(ch) * n * 4


@pytest.mark.skipif(not _payloads(), reason='没有当前代次的 lighting3 载荷')
def test_求积解析锚点() -> None:  # noqa: N802
    """无遮挡时的 y⁰ 传输必须落在 `(1+cos β)/2` 上（求积本身对不对）。"""
    import math

    from tools.scene_relight.bake_gbuffer import sky_directions
    dirs = sky_directions()
    for beta in (0, 30, 45, 60, 90, 180):
        N = np.array([0.0, math.cos(math.radians(beta)), math.sin(math.radians(beta))])
        num = sum(w * max(min(float(N @ dw), 1.0), 0.0) for dw, w in dirs)
        den = sum(w * max(float(dw[1]), 0.0) for dw, w in dirs)
        assert abs(num / den - (1 + math.cos(math.radians(beta))) / 2) < 0.007, beta
