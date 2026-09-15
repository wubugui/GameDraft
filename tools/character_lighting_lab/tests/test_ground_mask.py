"""地面掩膜的连通口径(`ground_flood`)与"地面标定失败必须响"。

背景(2026-09-14):崖墓正式是多层台地构图(院坝 / 上栈道 / 下崖台之间隔着竖直崖面),
朝上候选断开,只从画面底边洪泛永远只捡到最下面那层 —— 地面标定把其余几层当墙,
手持光源在那里照不亮、碰撞把院坝整片封死。`ground_flood='all'` 为这类构图而设。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.character_lighting_lab import pipeline as pl  # noqa: E402

THETA = math.radians(45.0)
H, W = 120, 160


def _terraces():
    """两层水平台地,中间一段竖直崖面把朝上候选切断;上层不与底边连通。

    伪世界里水平地面 Y 恒定 ⇔ d = qy / tanθ + c;竖直面 ⇔ d 沿屏幕 y 不变。
    """
    ppu = 40.0
    sy = np.arange(H, dtype=np.float32)[:, None]
    qy = ((H / 2 - sy) / ppu * np.ones((1, W))).astype(np.float32)
    d = np.empty((H, W), np.float32)
    top = slice(0, 40)        # 上层台地(不接底边)
    wall = slice(40, 70)      # 竖直崖面:d 不随 y 变
    low = slice(70, H)        # 下层台地(接底边)
    d[top] = qy[top] / math.tan(THETA) + 1.0
    d[wall] = d[39:40]
    d[low] = qy[low] / math.tan(THETA) + (d[69, 0] - qy[70, 0] / math.tan(THETA))
    return d, qy


def test_缺省只收与底边连通的地面():
    d, qy = _terraces()
    m = pl.ground_mask_for(d, qy, THETA, dict(pl.DEFAULTS))
    assert m[80:, :].mean() > 0.9, "下层台地应当是地面"
    assert m[5:35, :].mean() < 0.05, "缺省口径不收不接底边的上层台地(挡屋顶)"


def test_flood_all_收下不接底边的大块台地():
    d, qy = _terraces()
    m = pl.ground_mask_for(d, qy, THETA, {**pl.DEFAULTS, "ground_flood": "all"})
    assert m[80:, :].mean() > 0.9
    assert m[5:35, :].mean() > 0.9, "多层台地:上层也是地面"
    assert m[45:65, :].mean() < 0.05, "竖直崖面仍不是地面"


def test_flood_all_不收小块_例如墓龛底板():
    d, qy = _terraces()
    # 在崖面上开一个 4x4 的朝上小平台:面积远小于 1% 画幅
    d[50:54, 20:24] = qy[50:54, 20:24] / math.tan(THETA) + (d[50, 20] - qy[50, 20] / math.tan(THETA))
    m = pl.ground_mask_for(d, qy, THETA, {**pl.DEFAULTS, "ground_flood": "all"})
    assert not m[50:54, 20:24].any()


def test_未知口径直接报错():
    d, qy = _terraces()
    try:
        pl.ground_mask_for(d, qy, THETA, {**pl.DEFAULTS, "ground_flood": "roofs"})
    except ValueError:
        return
    raise AssertionError("未知的 ground_flood 必须报错,不许静默当 bottom")


def test_新增几何参数只在偏离缺省时进签名(tmp_path):
    """老 manifest 没有这两个键:取签名不许 KeyError,也不许让存量烘焙全体变"过期"。"""
    old = {k: v for k, v in pl.DEFAULTS.items() if k not in ("ground_flood", "ground_min_component_frac")}
    a = pl.geometry_signature(tmp_path, "h", old)
    b = pl.geometry_signature(tmp_path, "h", dict(pl.DEFAULTS))
    c = pl.geometry_signature(tmp_path, "h", {**pl.DEFAULTS, "ground_flood": "all"})
    assert a == b and b != c
