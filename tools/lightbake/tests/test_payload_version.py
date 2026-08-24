# -*- coding: utf-8 -*-
"""载荷版本三处钉死(§4.1):tools/lightbake/const.py / SceneLightingSystem.ts /
tools/editor/validator.py。历史上一天内漂过两次 —— 这个测试就是那道闸。"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from tools.lightbake.const import PAYLOAD_VERSION

ROOT = Path(__file__).resolve().parents[3]


def _grep_int(path: Path, pattern: str) -> int:
    m = re.search(pattern, path.read_text(encoding='utf-8'))
    assert m, f'{path} 里找不到 {pattern}'
    return int(m.group(1))


def test_lightbake_version_is_6():
    assert PAYLOAD_VERSION == 6


def test_runtime_and_validator_agree_with_each_other():
    rt = _grep_int(ROOT / 'src/core/SceneLightingSystem.ts',
                   r'LIGHTING3_VERSION\s*=\s*(\d+)')
    va = _grep_int(ROOT / 'tools/editor/validator.py',
                   r'_LIGHTING3_VERSION\s*=\s*(\d+)')
    assert rt == va, f'运行时 {rt} 与校验器 {va} 漂移'


@pytest.mark.xfail(strict=True,
                   reason='P7 运行时接 v6 未落地(本次交付只读 src/,接线是制作人'
                          '拍板后的独立改动)。strict:接线落地当天 XPASS→FAIL,'
                          '逼着删掉本 marker,闸门自动转正(审查纠正)')
def test_runtime_matches_lightbake():
    rt = _grep_int(ROOT / 'src/core/SceneLightingSystem.ts',
                   r'LIGHTING3_VERSION\s*=\s*(\d+)')
    assert rt == PAYLOAD_VERSION


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
