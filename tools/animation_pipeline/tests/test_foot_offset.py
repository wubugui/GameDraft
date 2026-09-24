"""脚底偏移的量法（`tools.animation_pipeline.foot_offset`）：最贴地那一帧、帧高比例、空帧不参与、写盘只动一个键。"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image

from tools.animation_pipeline.foot_offset import (
    ALPHA_THRESHOLD,
    apply_offsets,
    is_ground_bundle,
    load_alpha,
    measure_bundle,
    state_foot_offset,
)

CW, CH = 10, 40


def _atlas(bottoms: list[int | None]) -> np.ndarray:
    """一行多格；每格在第 bottom 行（含）以上画一块不透明，None = 空格。"""
    a = np.zeros((CH, CW * len(bottoms), 4), np.uint8)
    for i, b in enumerate(bottoms):
        if b is not None:
            a[b - 10:b + 1, i * CW + 2:i * CW + 8] = 255
    return a


class FootOffsetMeasureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.td = TemporaryDirectory()
        self.dir = Path(self.td.name) / 'npc_x_anim'
        self.dir.mkdir()
        # 格 0 脚在第 34 行（离帧底 5 px）、格 1 在第 37 行（2 px）、格 2 空、格 3 只有半透明
        rgba = _atlas([34, 37, None, 30])
        rgba[20:31, 3 * CW:4 * CW, 3] = ALPHA_THRESHOLD - 1
        Image.fromarray(rgba, 'RGBA').save(self.dir / 'atlas.png')
        self.anim = {
            'spritesheet': 'atlas.png', 'cols': 4, 'rows': 1, 'cellWidth': CW, 'cellHeight': CH,
            'states': {
                'walk': {'frames': [0, 1, 0], 'frameRate': 8, 'loop': True},
                'idle': {'frames': [0], 'frameRate': 8, 'loop': True, 'footOffset': 0.9},
                'ghost': {'frames': [2, 3], 'frameRate': 8, 'loop': True},
            },
        }
        (self.dir / 'anim.json').write_text(json.dumps(self.anim), encoding='utf-8')

    def tearDown(self) -> None:
        self.td.cleanup()

    def test_min_margin_over_state_frames(self) -> None:
        alpha = load_alpha(self.dir / 'atlas.png')
        self.assertAlmostEqual(state_foot_offset(self.anim, alpha, [0, 1]), 2 / CH)
        self.assertAlmostEqual(state_foot_offset(self.anim, alpha, [0]), 5 / CH)

    def test_empty_and_translucent_frames_do_not_count(self) -> None:
        alpha = load_alpha(self.dir / 'atlas.png')
        self.assertIsNone(state_foot_offset(self.anim, alpha, [2, 3]))
        self.assertAlmostEqual(state_foot_offset(self.anim, alpha, [2, 0]), 5 / CH)

    def test_atlas_frames_box_height_is_the_base(self) -> None:
        alpha = load_alpha(self.dir / 'atlas.png')
        anim = {**self.anim, 'atlasFrames': [{'width': CW, 'height': 36}] * 4}
        # 帧框只到第 35 行：格 0 的脚（34 行）离帧底 1 px，基准是 36
        self.assertAlmostEqual(state_foot_offset(anim, alpha, [0]), 1 / 36)

    def test_apply_writes_measured_and_removes_zero(self) -> None:
        anim, offs = measure_bundle(self.dir)
        changed = apply_offsets(anim, offs)
        self.assertTrue(changed)
        st = anim['states']
        self.assertEqual(st['walk']['footOffset'], round(2 / CH, 4))
        self.assertEqual(st['idle']['footOffset'], round(5 / CH, 4), '手填的错值被实测值覆盖')
        self.assertNotIn('footOffset', st['ghost'], '量不出 ⇒ 不写')
        self.assertEqual(list(st['walk'].keys()), ['frames', 'frameRate', 'loop', 'footOffset'])
        self.assertFalse(apply_offsets(anim, offs), '再写一遍没有变化')

    def test_fx_bundles_are_not_ground(self) -> None:
        self.assertFalse(is_ground_bundle('fx_patron_drinker'))
        self.assertTrue(is_ground_bundle('npc_popo_anim'))


if __name__ == '__main__':
    unittest.main()
