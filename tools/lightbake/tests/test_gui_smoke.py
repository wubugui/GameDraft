# -*- coding: utf-8 -*-
"""GUI 壳的冒烟:能 import、依赖齐(PySide6 / 编辑器统一写盘出口)。

完整烘焙走的是 pipeline 同一条链(§11.1),GUI 自身零烘焙逻辑 ——
所以这里只验壳的装配面,不重复烘焙测试。
"""
from __future__ import annotations

import pytest


def test_gui_module_imports():
    pytest.importorskip('PySide6')
    from tools.lightbake.gui import app
    assert callable(app.run_gui)


def test_editor_write_exit_available():
    """存回 bakeSky 必须走编辑器统一写盘出口(editor-tools norms 第一戒)。"""
    from tools.editor.file_io import read_json, write_json
    assert callable(read_json) and callable(write_json)


def test_gui_offscreen_construct_and_render():
    """离屏构造 + 注入假 ctx + 五个通道各渲一帧(壳的装配面真跑一遍)。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    import numpy as np
    from tools.lightbake.gui.app import create_window
    h, w = 24, 32
    ctx = {
        'sky_spec': {'mode': 'color', 'color': [1, 1, 1], 'intensity': 0.05},
        'e': np.random.default_rng(0).uniform(0, 1, (h, w, 3)).astype(np.float32),
        'sun': {'found': False},
        'gain': 1.0,
        'hdr_work': np.random.default_rng(1).uniform(0, 2, (h, w, 3)).astype(np.float32),
        'moments_smooth': (
            np.random.default_rng(2).uniform(0, 0.5, (h, w)).astype(np.float32),
            np.random.default_rng(3).uniform(-0.4, 0.4, (h, w, 3)).astype(np.float32)),
        'normal': np.tile(np.array([0, 1, 0], np.float32), (h, w, 1)),
        'ao': np.random.default_rng(4).uniform(0, 1, (h, w)).astype(np.float32),
    }
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx)
    for i in range(win.channel.count()):
        win.channel.setCurrentIndex(i)
        win._render()
    assert win.view.pixmap() is not None and not win.view.pixmap().isNull()
    # 天空面板 → spec 往返
    win.mode.setCurrentText('color')
    win.r.setValue(0.3)
    win.inten.setValue(0.7)
    spec = win._spec()
    assert spec['mode'] == 'color'
    assert abs(spec['color'][0] - 0.3) < 1e-9
    assert abs(spec['intensity'] - 0.7) < 1e-9


def test_gui_source_has_no_bake_logic():
    """壳纪律:gui/ 不许出现烘焙逻辑的直接实现 —— 不只是 tracer,
    太阳合成/闭式系数/矩归约这类公式也不许手抄(审查:此前只挡 tracer,
    §5.6/§5.7 的公式被原样抄进过 GUI)。"""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / 'gui' / 'app.py'
           ).read_text(encoding='utf-8')
    for forbidden in ('from .trace', 'from ..trace', 'import trace',
                      '_march', 'prange',
                      'vdir_coeffs', 'alpha + beta', '@ sdir',
                      'np.percentile(ratio', 'sky_moments('):
        assert forbidden not in src, forbidden
    # 组合公式必须走唯一实现
    assert 'compose_sun_e' in src
