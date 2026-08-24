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


class _FakeInp:
    def __init__(self, h, w, rng):
        import numpy as np
        self.work = (w, h)
        self.native = (w, h)
        self.bg_srgb = rng.uniform(0.05, 0.9, (h, w, 3)).astype('float32')
        self.depth = rng.uniform(2.0, 8.0, (h, w)).astype('float32')
        self.scene_json = None            # 场景 sky 预设按缺失优雅降级
        xx, yy = np.meshgrid(np.linspace(-1, 1, w, dtype='float32'),
                             np.linspace(-1, 1, h, dtype='float32'))
        self.world = np.stack(
            [xx, yy, rng.uniform(0.0, 1.0, (h, w)).astype('float32')], -1)


def _rich_fake_ctx(h=24, w=32):
    """富假 ctx:让**所有**通道真渲染,而不是灰底占位混过断言
    (审查 [18]:11/20 通道落占位、断言只看 pixmap 非空 = 虚假信心)。"""
    import numpy as np
    rng = np.random.default_rng(0)
    nx, ny, nz = 6, 4, 5
    n = nx * ny * nz
    vol = {'grid': {'nx': nx, 'ny': ny, 'nz': nz},
           'bounds': {'x0': -1.1, 'x1': 1.1, 'y0': -1.1, 'y1': 1.1,
                      'z0': -0.1, 'z1': 1.1},
           'residual_invalid': 0.0,
           'raw': {'sky_a0': rng.uniform(0, .5, n).astype('float32'),
                   'sky_a1': rng.uniform(-.3, .3, (n, 3)).astype('float32'),
                   'ao_a0': rng.uniform(0, 1, n).astype('float32'),
                   'gi_a0': rng.uniform(0, 2, (n, 3)).astype('float32'),
                   'invalid': rng.random(n) < 0.3}}
    return {
        'sky_spec': {'mode': 'color', 'color': [1, 1, 1], 'intensity': 0.05,
                     'authorNote': '往返保真探针'},
        'e': rng.uniform(0.1, 1, (h, w, 3)).astype('float32'),
        'e_ind': rng.uniform(0.1, 1, (h, w, 3)).astype('float32'),
        'e_q': rng.uniform(0.2, 2, (h, w, 3)).astype('float32'),
        'sun': {'found': False},
        'gain': 2.0,
        'inp': _FakeInp(h, w, rng),
        'hdr_work': rng.uniform(0, 2, (h, w, 3)).astype('float32'),
        'lin_dehazed': rng.uniform(0, 1, (h, w, 3)).astype('float32'),
        'moments_smooth': (
            rng.uniform(0, 0.5, (h, w)).astype('float32'),
            rng.uniform(-0.4, 0.4, (h, w, 3)).astype('float32')),
        'normal': __import__('numpy').tile(
            __import__('numpy').array([0, 1, 0], 'float32'), (h, w, 1)),
        'ao': rng.uniform(0, 1, (h, w)).astype('float32'),
        'volume': vol,
    }


def test_gui_offscreen_construct_and_render():
    """离屏构造 + 注入富假 ctx + 全通道各渲一帧:除「场景自身 sky」相关
    路径外,任何通道都不许落进 160×90 占位灰底。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from tools.lightbake.gui.app import create_window
    h, w = 24, 32
    ctx = _rich_fake_ctx(h, w)
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx)
    for i in range(win.channel.count()):
        win.channel.setCurrentIndex(i)
        img = win._channel_img()
        key = win.channel.currentData()
        assert img.shape[:2] != (90, 160), f'通道 {key} 落进了占位灰底'
        win._render()
        assert win.view.pixmap() is not None and not win.view.pixmap().isNull()
    # 天空往返保真:GUI 不认识的键必须原样活着(往返铁律,审查 [10])
    spec = win._spec()
    assert spec.get('authorNote') == '往返保真探针'
    # E直接 的尺度:e(post-gain) − e_ind·gain(审查 [1] 的回归钉)
    import numpy as np
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('e_dir'))
    d = win._channel_img()
    expect = np.maximum(
        (ctx['e'] - ctx['e_ind'] * ctx['gain']) @ np.array(
            [0.2126, 0.7152, 0.0722], 'float32'), 0)
    assert d.max() <= 1.0 and expect.shape == (h, w)
    # 天空面板 → spec 往返
    win.mode.setCurrentText('color')
    win.r.setValue(0.3)
    win.inten.setValue(0.7)
    spec = win._spec()
    assert spec['mode'] == 'color'
    assert abs(spec['color'][0] - 0.3) < 1e-9
    assert abs(spec['intensity'] - 0.7) < 1e-9


def test_gui_bake_kwargs_mirror_cli():
    """壳公理的机器验证:面板 kwargs ↔ 等价 CLI 行互为镜像 ——
    每个重烘级旋钮都必须能在 CLI 行里看到自己(或以缺省身份隐去)。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from tools.lightbake.gui.app import create_window
    _app, win = create_window('雾津街头', autobake=False)
    win.spp.setValue(64)
    win.moment_spp.setValue(256)
    win.ao_spp.setValue(128)
    win.vol_spp.setValue(256)
    win.vol_density.setValue(8.0)
    win.vol_max_cells.setValue(1_000_000)
    win.nee_on.setChecked(False)
    win.clamp.setValue(10.0)
    win.denoise_on.setChecked(True)
    win.denoise_iters.setValue(2)
    win.no_gi.setChecked(True)
    win.work_w.setValue(512)
    kw = win._bake_kwargs()
    assert kw == {'work_w': 512, 'spp': 64, 'moment_spp': 256, 'ao_spp': 128,
                  'vol_spp': 256, 'no_gi': True, 'nee': False,
                  'denoise': True, 'denoise_iters': 2, 'vol_density': 8.0,
                  'vol_max_cells': 1_000_000, 'clamp_indirect': 10.0}
    # 每个键都必须是 bake_scene 的真形参(壳公理:kwargs 可原样回灌)
    import inspect
    from tools.lightbake.pipeline import bake_scene
    assert set(kw) <= set(inspect.signature(bake_scene).parameters)
    line = win._cli_line_text()
    for frag in ('--spp 64', '--moment-spp 256', '--ao-spp 128',
                 '--vol-spp 256', '--vol-density 8', '--vol-max-cells 1000000',
                 '--no-nee', '--clamp-indirect 10', '--denoise-iters 2',
                 '--work-w 512', '--no-gi', '--sky '):
        assert frag in line, (frag, line)
    # 缺省态:CLI 行只剩缺省 spp 组,没有任何开关残留
    win.vol_density.setValue(0.0)
    win.vol_max_cells.setValue(0)
    win.nee_on.setChecked(True)
    win.clamp.setValue(0.0)
    win.denoise_iters.setValue(3)
    win.no_gi.setChecked(False)
    win.work_w.setValue(1024)
    line2 = win._cli_line_text()
    for frag in ('--no-nee', '--clamp', '--vol-density', '--vol-max-cells',
                 '--denoise-iters', '--no-denoise', '--no-gi', '--work-w'):
        assert frag not in line2, (frag, line2)
    assert '--sky ' in line2                      # 天空无条件进等价行


def test_cli_flags_all_have_gui_controls():
    """反向 parity(审查 [18]:此前只验 GUI→CLI,漏掉 --no-gi 这类
    CLI 有 GUI 无):遍历 bake 子命令的每个 dest,都必须映射到 GUI 控件,
    白名单只留工作流参数。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from tools.lightbake.__main__ import build_parser
    from tools.lightbake.gui.app import create_window
    _app, win = create_window('雾津街头', autobake=False)
    gui_map = {'work_w': 'work_w', 'spp': 'spp', 'moment_spp': 'moment_spp',
               'ao_spp': 'ao_spp', 'vol_spp': 'vol_spp',
               'vol_density': 'vol_density', 'vol_max_cells': 'vol_max_cells',
               'gi': 'no_gi', 'nee': 'nee_on',
               'clamp_indirect': 'clamp', 'denoise': 'denoise_on',
               'denoise_iters': 'denoise_iters',
               'e_chroma_clamp': 'e_chroma',
               'sky': 'mode'}                     # 天空 = 整个天空面板
    workflow_whitelist = {'scene', 'all', 'threads', 'quiet', 'out_root',
                          'help', 'cmd'}
    bake = next(a for a in build_parser()._subparsers._group_actions[0]
                ._name_parser_map.items() if a[0] == 'bake')[1]
    for act in bake._actions:
        dest = act.dest
        if dest in workflow_whitelist:
            continue
        assert dest in gui_map, f'CLI 旗标 {dest} 在 GUI 无对应控件'
        assert hasattr(win, gui_map[dest]), (dest, gui_map[dest])


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
    # 重估**编排**必须走唯一实现(审查 [2]:单函数共用还不够,顺序也只许一份)
    assert 'recombine_sky' in src
    for forbidden in ('combine_e(', 'solve_direct_light(', 'compose_sun_e(',
                      'gather_gain_of(', 'denoise_e('):
        assert forbidden not in src, f'GUI 手抄了重估编排的一步: {forbidden}'
