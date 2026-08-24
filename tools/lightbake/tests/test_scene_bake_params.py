# -*- coding: utf-8 -*-
"""逐场景质量参数 lighting.bakeParams(2026-08-25 制作人「4搞」):
camel↔snake 映射、未知键/错类型硬错、三级决议(显式 > 场景 > 库缺省)、
CLI None=未指定 的透传。"""
from __future__ import annotations

import pytest

from tools.lightbake.__main__ import _quality_kwargs, build_parser
from tools.lightbake.const import GATHER_SPP, MOMENT_SPP
from tools.lightbake.input import _BP_CAMEL, _BP_SNAKE, parse_bake_params
from tools.lightbake.pipeline import _BP_DEFAULTS, _resolve_bp


def test_parse_camel_to_snake_and_back():
    raw = {'volDensity': 4, 'spp': 64, 'momentSpp': 256, 'nee': False,
           'denoiseIters': 2}
    out = parse_bake_params(raw)
    assert out == {'vol_density': 4, 'spp': 64, 'moment_spp': 256,
                   'nee': False, 'denoise_iters': 2}
    # 键表双射:每个 snake 键都能映回唯一 camel 键
    assert {_BP_SNAKE[v] for v in out} <= set(_BP_CAMEL)


def test_parse_rejects_unknown_key_and_wrong_type():
    with pytest.raises(ValueError, match='未知键'):
        parse_bake_params({'volDensty': 4})        # 拼写错必须炸,不许静默
    with pytest.raises(ValueError, match='类型错'):
        parse_bake_params({'spp': '64'})
    with pytest.raises(ValueError, match='类型错'):
        parse_bake_params({'spp': True})           # bool 不许冒充 int
    with pytest.raises(ValueError, match='必须是对象'):
        parse_bake_params([1, 2])
    assert parse_bake_params(None) == {}


def test_resolution_precedence():
    scene = {'vol_density': 4.0, 'spp': 64, 'nee': False}
    # 显式压场景
    r = _resolve_bp({**{k: None for k in _BP_DEFAULTS}, 'spp': 128}, scene)
    assert r['spp'] == 128
    # 场景压库缺省
    assert r['vol_density'] == 4.0
    assert r['nee'] is False
    # 都没给 ⇒ 库缺省
    assert r['moment_spp'] == MOMENT_SPP
    # 全 None + 空场景 ⇒ 全库缺省
    r2 = _resolve_bp({k: None for k in _BP_DEFAULTS}, {})
    assert r2['spp'] == GATHER_SPP and r2['nee'] is True


def test_cli_defaults_are_unset():
    """CLI 不带旗标 ⇒ 全 None(未指定),场景 bakeParams 才有生效空间;
    带旗标 ⇒ 显式值;--nee 能显式压过场景的关闭。"""
    ap = build_parser()
    a = ap.parse_args(['bake', '--scene', 'x'])
    kw = _quality_kwargs(a)
    for k in ('work_w', 'spp', 'moment_spp', 'ao_spp', 'vol_spp',
              'vol_density', 'vol_max_cells', 'no_gi', 'nee',
              'clamp_indirect', 'denoise', 'denoise_iters'):
        assert kw[k] is None, k
    b = ap.parse_args(['bake', '--scene', 'x', '--nee', '--no-denoise',
                       '--no-gi', '--spp', '64'])
    kb = _quality_kwargs(b)
    assert kb['nee'] is True and kb['denoise'] is False
    assert kb['no_gi'] is True and kb['spp'] == 64


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
