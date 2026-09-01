"""重打光工作台**自己的**那点东西:工作目录、手绘发光 mask、带变体状态的场景清单。

几何(深度解码 / 伪世界重建 / 天穹 march)**不在这里** —— 2026-08-31 起统一由
`tools.character_lighting_lab.scene_geometry` 提供,本工具是它的**下游消费者**。
理由:深度与标定本来就是实验室导出的,几何却曾在这里重建一遍,同一份东西两处实现。

本工具现在的职责只剩一件:**离线把白天原画重打光成某个时段的原画**
(`--export`,产物是 `background_relight_<预设>.png` + 一段 `timeVariants` snippet)。
运行时**不做**整体重打光——那条路 2026-08-30 已被「原画就是最终的光照」取代,
见 `agent_docs/runtime/mechanisms/scene-lighting.md`。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

# ⚠ 按**模块**引用而不是 `from ... import SCENES_RT`:那样是按值绑定,
#   测试里 monkeypatch `scene_geometry.SCENES_RT` 就打不到这里,
#   于是"临时工程"的用例会静默去读真实仓库。
from tools.character_lighting_lab import scene_geometry as _geo

#: 本工具的工作目录(手刷的发光 mask、逐场景预设参数、导出备份)。**进 git**。
OUT = Path(__file__).resolve().parent / 'out'


def emissive_mask(sid: str, size: tuple[int, int]) -> np.ndarray | None:
    """手绘发光 mask(`out/<sid>/emissive_mask.png`,白=发光),缺省 None。

    这是**本工具的作者面产物**,不是几何——所以它留在这里,没跟着几何搬去实验室。
    """
    f = OUT / sid / 'emissive_mask.png'
    if not f.exists():
        return None
    m = np.asarray(Image.open(f).convert('L'), np.float32) / 255.0
    if m.shape[::-1] != size:
        m = _geo.resize_f(m, size)
    return m


def list_scenes() -> list[dict]:
    """场景清单 = 实验室那份几何状态 + 本工具关心的两项(手绘 mask / 已导出的变体)。"""
    out = []
    for s in _geo.list_scenes():
        sid = s['id']
        rt = _geo.SCENES_RT / sid
        variants = sorted(p.name for p in rt.glob('background_relight_*.png')) \
            if rt.is_dir() else []
        out.append({**s,
                    'mask': (OUT / sid / 'emissive_mask.png').exists(),
                    'variants': variants})
    return out


__all__ = ['OUT', 'emissive_mask', 'list_scenes']
