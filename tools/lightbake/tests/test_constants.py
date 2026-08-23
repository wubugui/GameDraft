"""常量钉死（方案 §9）。数值漂了这里红。"""
from __future__ import annotations

from tools.lightbake import const


def test_constants_pinned():
    assert const.WORK_W == 1024
    assert const.GATHER_SPP == 16
    assert const.GATHER_STEP_PX == 0.5
    assert const.GATHER_SEED == 20260823
    assert const.MARCH_BIAS == 0.025
    assert const.MARCH_BIAS_GROWTH == 0.015
    assert const.MARCH_THICKNESS == 0.75
    assert const.HDR_MAX == 200.0
    assert const.HDR_LOG_SPAN_MIN == 8.0
    assert const.HDR_LOG_SPAN_MAX == 24.0
    assert const.HDR_LOG_FLOOR_PCT == 0.1
    assert const.HAZE_KEEP == 0.1
    assert const.GATHER_GAIN_PERCENTILE == 95.0
    assert const.GATHER_GAIN_MAX == 12.0
    assert (const.SUN_SCAN_EL, const.SUN_SCAN_AZ) == (7, 16)
    assert const.SUN_CHROMA_CLAMP == (0.78, 1.28)
    assert (const.AO_STEPS, const.AO_LENGTH) == (10, 0.25)
    assert const.CHAR_VOL_SPP == 64
    assert (const.CHAR_VOL_CELLS_PER_CHAR_XZ, const.CHAR_VOL_CELLS_PER_CHAR_Y) == (3.0, 6.0)
    assert const.CHAR_VOL_MAX_CELLS == 200_000
