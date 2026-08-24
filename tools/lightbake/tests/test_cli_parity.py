# -*- coding: utf-8 -*-
"""CLI ↔ bake_scene 的镜像契约(2026-08-25 一致性审查落测):
- 质量旗标 → _quality_kwargs 的每个键都是 bake_scene 真形参;
- 三个子命令(bake/check/report)共享同一组质量旗标;
- 缺省值与 bake_scene 缺省一致;
- 危险哨兵(--clamp-indirect 0 会清零间接光 / --vol-density 0)入口即拒。
"""
from __future__ import annotations

import inspect

import pytest

from tools.lightbake.__main__ import _quality_kwargs, build_parser
from tools.lightbake.pipeline import bake_scene


def test_quality_kwargs_subset_and_defaults():
    ap = build_parser()
    args = ap.parse_args(['bake', '--scene', 'x'])
    kw = _quality_kwargs(args)
    sig = inspect.signature(bake_scene).parameters
    assert set(kw) <= set(sig), set(kw) - set(sig)
    for k, v in kw.items():
        if v is None or k == 'sky_override':
            continue
        assert sig[k].default == v, (k, v, sig[k].default)


def test_check_and_report_share_quality_flags():
    ap = build_parser()
    for sub in ('check', 'report'):
        a = ap.parse_args([sub, '--scene', 'x', '--spp', '64',
                           '--moment-spp', '256', '--no-nee',
                           '--denoise-iters', '0'])
        kw = _quality_kwargs(a)
        assert kw['spp'] == 64
        assert kw['moment_spp'] == 256
        assert kw['nee'] is False
        assert kw['denoise_iters'] == 0


def test_dangerous_sentinels_rejected():
    ap = build_parser()
    for bad in (['bake', '--scene', 'x', '--clamp-indirect', '0'],
                ['bake', '--scene', 'x', '--clamp-indirect', '-1'],
                ['bake', '--scene', 'x', '--vol-density', '0']):
        with pytest.raises(SystemExit):
            ap.parse_args(bad)


def test_bake_has_out_root_and_threads():
    ap = build_parser()
    a = ap.parse_args(['bake', '--scene', 'x', '--out-root', 'D:/tmp',
                       '--threads', '4'])
    assert a.out_root == 'D:/tmp'
    assert a.threads == 4


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
