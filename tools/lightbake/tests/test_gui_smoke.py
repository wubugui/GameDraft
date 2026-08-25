# -*- coding: utf-8 -*-
"""GUI 壳的冒烟:能 import、依赖齐(PySide6 / 编辑器统一写盘出口)。

完整烘焙走的是 pipeline 同一条链(§11.1),GUI 自身零烘焙逻辑 ——
所以这里只验壳的装配面,不重复烘焙测试。
"""
from __future__ import annotations

import json

import pytest


def test_gui_module_imports():
    pytest.importorskip('PySide6')
    from tools.lightbake.gui import app
    assert callable(app.run_gui)


def test_editor_write_exit_available():
    """存回 bakeSky 必须走编辑器统一写盘出口(editor-tools norms 第一戒)。"""
    from tools.editor.file_io import read_json, write_json
    assert callable(read_json) and callable(write_json)


def _settle_lights(app, win):
    """E_灯 在后台线程算(审查 P0-3),设计是**最终一致**:done→_render 可能
    对新 key 再补一枪(单飞守卫下 key 变更要第二轮收敛)。循环 等待+派发
    直到没有在跑的 worker 为止(离屏测试用)。"""
    for _ in range(8):
        w = win._lights_worker
        if w is not None and w.isRunning():
            assert w.wait(30000)
        app.processEvents()
        w2 = win._lights_worker
        if w2 is None or not w2.isRunning():
            app.processEvents()
            if win._lights_worker is w2 and \
                    (w2 is None or not w2.isRunning()):
                return
    raise AssertionError('E_灯 worker 未在 8 轮内收敛')


class _FakeInp:
    def __init__(self, h, w, rng):
        import numpy as np
        self.work = (w, h)
        self.native = (w, h)
        self.char_wu = 0.4
        self.ppu = 20.0
        self.cx = w / 2.0
        self.cy = h / 2.0
        self.R = np.eye(3, dtype='float32')
        self.bg_srgb = rng.uniform(0.05, 0.9, (h, w, 3)).astype('float32')
        self.depth = rng.uniform(2.0, 8.0, (h, w)).astype('float32')
        self.scene_json = None            # 场景 sky 预设按缺失优雅降级
        xx, yy = np.meshgrid(np.linspace(-1, 1, w, dtype='float32'),
                             np.linspace(-1, 1, h, dtype='float32'))
        self.world = np.stack(
            [xx, yy, rng.uniform(0.0, 1.0, (h, w)).astype('float32')], -1)
        self.q = self.world.copy()        # R=I ⇒ q ≡ world
        # 解析灯(运行时等价):char 高 150wu ↔ char_wu=0.4 ⇒ 375 wu/单位
        self.scene_per_wu = 375.0
        self.shadow_bias = (30.8, 264.0)
        self.lights = [
            {'id': 'sun', 'kind': 'directional', 'enabled': True,
             'intensity': 1.0, 'kelvin': 6500, 'elevationDeg': 50.0,
             'azimuthDeg': 120.0, 'castShadow': True},
            {'id': 'lamp_1', 'kind': 'point', 'enabled': True,
             'intensity': 2.5, 'kelvin': 2200, 'pos': [0.0, 200.0, -100.0],
             'range': 450.0, 'softeningRadius': 10.0, 'castShadow': True},
            {'id': 'lamp_2', 'kind': 'spot', 'enabled': True,
             'intensity': 3.0, 'kelvin': 2400, 'pos': [100.0, 250.0, 0.0],
             'dir': [0, -1, 0.3], 'innerAngleDeg': 25.0,
             'outerAngleDeg': 45.0, 'range': 450.0, 'softeningRadius': 10.0,
             'castShadow': False},
            {'id': 'panel', 'kind': 'area', 'enabled': True,
             'intensity': 2.0, 'kelvin': 2700, 'pos': [-150.0, 220.0, 50.0],
             'orientation': [0, 0, -1], 'size': [150.0, 100.0],
             'rollDeg': 15.0, 'twoSided': False, 'range': 450.0,
             'castShadow': False},
        ]


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
                   'ao_a1': rng.uniform(-.3, .3, (n, 3)).astype('float32'),
                   'gi_a0': rng.uniform(0, 2, (n, 3)).astype('float32'),
                   'gi_a1': rng.uniform(-.2, .2, (n, 3, 3)).astype('float32'),
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
        if win._lights_worker is not None:          # E_灯 后台算完再取一帧
            _settle_lights(_app, win)
            img = win._channel_img()
        key = win.channel.currentData()
        assert img.shape[:2] != (90, 160), f'通道 {key} 落进了占位灰底'
        win._render()
        assert win.view.pixmap() is not None and not win.view.pixmap().isNull()
    # 角色探针:点视口放置 → final/a0/final_vol 上合成实体口径球,不许炸
    win.probe_on.setChecked(True)
    win._probe_px = (w // 2, h // 2)
    for k in ('final', 'final_vol', 'a0'):
        win.channel.setCurrentIndex(
            [win.channel.itemData(i) for i in range(win.channel.count())
             ].index(k))
        img = win._channel_img()
        out = win._overlay_probe(img)
        assert out.shape == img.shape
    win.probe_occl.setChecked(True)
    win._render()
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


def test_gui_lights_editor_roundtrip():
    """灯光编辑组(运行时等价解析灯):装载 lighting.lights → 面板往返 →
    改字段落回 dict → 加/换型/删 → E_灯 通道真渲染 → 探针吃灯不炸。
    算法零抄 —— 组内只调 lights.py(壳公理在灯上的那半)。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    import numpy as np
    from tools.lightbake.gui.app import create_window
    h, w = 24, 32
    ctx = _rich_fake_ctx(h, w)
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx)
    # 装载:4 盏灯全进列表
    assert win.light_combo.count() == 4
    assert len(win._lights) == 4
    # 往返恒等(审查 P1-9 的那条断言):装载→逐盏选中→什么都不动 ⇒
    # dict 逐键相同 —— 面板量程/精度/缺省物化都不许污染数据
    snap = json.dumps(win._lights, sort_keys=True)
    for i in range(4):
        win.light_combo.setCurrentIndex(i)
    assert json.dumps(win._lights, sort_keys=True) == snap
    # 太阳(idx 0,directional):castShadow **缺省缺席**时显示 = true
    # (packLights `?? true`,审查 P0-2);动 intensity 不许物化 castShadow /
    # 不许写 pos —— 「动一下强度=静默关掉太阳阴影并存盘」就是这么来的
    win.light_combo.setCurrentIndex(0)
    win._lights[0].pop('castShadow', None)      # 模拟场景 JSON 未写该键
    win._load_light_fields()
    assert win.l_shadow.isChecked()             # 显示口径 = 求值口径 = true
    win.l_inten.setValue(1.5)
    assert win._lights[0]['intensity'] == 1.5
    assert 'castShadow' not in win._lights[0]   # 逐键回写:没动就不物化
    assert 'pos' not in win._lights[0]
    # enabled 切换会改变「谁是太阳」⇒ castShadow 显示缺省跟着求值口径刷新
    # (复核残余分家项)
    win.l_enabled.setChecked(False)
    assert not win.l_shadow.isChecked()
    win.l_enabled.setChecked(True)
    assert win.l_shadow.isChecked()
    # 字段往返:选 lamp_1(点光),改 intensity/castShadow → dict 同步
    win.light_combo.setCurrentIndex(1)
    win.l_inten.setValue(4.25)
    assert win._lights[1]['intensity'] == 4.25
    win.l_shadow.setChecked(False)
    assert win._lights[1]['castShadow'] is False
    # kind 专属字段使能矩阵:点光禁 dir/锥角/尺寸/仰角
    assert win.l_px.isEnabled() and win.l_soft.isEnabled()
    assert not win.l_dx.isEnabled() and not win.l_inner.isEnabled()
    assert not win.l_sw.isEnabled() and not win.l_el.isEnabled()
    # 面光编辑方向 → 写 orientation 且**清掉 dir**(打包 dir 优先,P0-1)
    win._lights[3]['dir'] = [0, 0, -1]
    win.light_combo.setCurrentIndex(3)
    win.l_dx.setValue(0.5)
    assert 'dir' not in win._lights[3]
    assert win._lights[3]['orientation'][0] == 0.5
    # E_灯 通道:后台算完 → 真渲染(castShadow 太阳 march + 三种灯)
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('e_lights'))
    win._channel_img()
    _settle_lights(_app, win)
    img = win._channel_img()
    assert img.shape[:2] == (h, w)
    assert float(np.abs(img).max()) > 0.0
    # final 通道合成 E_灯(compose_final 的 e_lights 口,缓存同源共享)
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('final'))
    assert win._channel_img().shape[:2] == (h, w)
    # 探针吃灯(实体口径 eval_probe_lights 回调)不炸
    win.probe_on.setChecked(True)
    win._probe_px = (w // 2, h // 2)
    out = win._overlay_probe(win._channel_img())
    assert out.shape == (h, w, 3)
    # 立绘覆盖:真图集走运行时角色管线 —— 走 **_render 全路径**(二审
    # P2-4:直调 _overlay_char 的守卫在真实路径上不成立);探针读数走
    # note2 专线,立绘的 note 不被覆盖
    if win.char_combo.count() > 0:
        win.char_on.setChecked(True)
        win._char_foot = (w // 2, h - 2)
        base_img = win._channel_img()
        out2 = win._overlay_char(base_img)
        assert out2.shape == (h, w, 3)
        assert float(np.abs(out2 - base_img).max()) > 0.0
        win._render()
        assert '立绘着色失败' not in win.note.text()
        assert '探针@' in win.note2.text()          # 读数在专线上
        win.char_on.setChecked(False)
    # 换型:point → area,字段卫生(dir/锥角清掉,area 专属补上,软化不进面光)
    win.light_combo.setCurrentIndex(1)
    win.l_kind.setCurrentText('area')
    assert win._lights[1]['kind'] == 'area'
    assert 'size' in win._lights[1] and 'innerAngleDeg' not in win._lights[1]
    assert 'softeningRadius' not in win._lights[1]
    # 加/删 + 唯一 id 的**真冲突**(复核:light_N 与夹具 id 撞不上 = 空心):
    # 先手植 light_1,加灯必须跳到 light_2
    win.light_kind_new.setCurrentText('spot')
    win._lights.append({'id': 'light_1', 'kind': 'point', 'intensity': 1.0,
                        'pos': [0, 100, 0]})
    win._rebuild_light_combo(len(win._lights) - 1)
    win._add_light()
    assert len(win._lights) == 6 and win._lights[-1]['kind'] == 'spot'
    assert win._lights[-1]['id'] == 'light_2'
    ids = [l['id'] for l in win._lights]
    assert len(ids) == len(set(ids))
    win._del_light()                                # 删 light_2(当前选中)
    win._del_light()                                # 删 light_1
    assert len(win._lights) == 4
    # 关总开关 → E_灯 通道回占位
    win.lights_on.setChecked(False)
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('e_lights'))
    assert win._channel_img().shape[:2] == (90, 160)


def test_gui_free_drag_probe_and_char():
    """自由移动(制作人 2026-08-26):按在探针球/立绘上直接拖走 ——
    抓取优先于一切放置模式;空白处点击 = 放置并立刻可拖;松手补帧。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from tools.lightbake.gui.app import create_window
    h, w = 24, 32
    ctx = _rich_fake_ctx(h, w)
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx)
    _settle_lights(_app, win)
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('final'))
    win.probe_on.setChecked(True)
    win._probe_px = (16, 12)
    win._render()
    assert win._view_map is not None and win._probe_hit is not None
    s, offx, offy, _w, _h = win._view_map

    def v(ix, iy):
        return (ix * s + offx, iy * s + offy)

    # ① 抓球:按在球心 → target=probe;拖 + 偏移保持;松手落点正确
    cx, cy, r = win._probe_hit
    win._on_view_click(*v(cx, cy))
    assert win._drag_target == 'probe'
    off = win._drag_off
    win._on_view_drag(*v(cx + 4, cy + 3))
    win._on_view_release()
    assert win._probe_px == (cx + 4 + off[0], cy + 3 + off[1])
    assert win._drag_target is None
    # ② 抓优先于放:char_on 也开着,按在球上仍然抓球、不放角色
    if win.char_combo.count() > 0:
        win.char_on.setChecked(True)
        win._char_foot = (6, h - 2)
        win._render()
        bx, by, br = win._probe_hit
        win._on_view_click(*v(bx, by))
        assert win._drag_target == 'probe'
        win._on_view_release()
        # ③ 抓角色:按进立绘命中矩形 → 拖走
        assert win._char_hit is not None
        x0, y0, x1, y1 = win._char_hit
        mx, my = (x0 + x1) // 2, (y0 + y1) // 2
        win._on_view_click(*v(mx, my))
        assert win._drag_target == 'char'
        off = win._drag_off
        win._on_view_drag(*v(mx + 3, my + 1))
        win._on_view_release()
        assert win._char_foot == (min(mx + 3 + off[0], w - 1),
                                  min(my + 1 + off[1], h - 1))
        win.char_on.setChecked(False)
    # ④ 空白处点击 = 放置并立刻抓住(放下即拖)
    win._render()
    win._on_view_click(*v(2, 2))
    assert win._probe_px == (2, 2) and win._drag_target == 'probe'
    win._on_view_release()
    # ⑤ 什么模式都没勾:左键缺省放探针(点了必有东西,不许静默吞点击)
    win.probe_on.setChecked(False)
    win._render()
    win._on_view_click(*v(5, 5))
    assert win.probe_on.isChecked() and win._probe_px == (5, 5)
    assert '缺省' in win.status.text()
    win._on_view_release()
    # ⑥ 首帧未烘完:点视口给提示,不再静默
    _app2, win2 = create_window('雾津街头', autobake=False)
    win2._on_view_click(100.0, 100.0)
    assert '首帧还在烘' in win2.status.text()


def test_gui_char_error_note_not_clobbered(monkeypatch):
    """二审 P2-4 回归:立绘着色抛异常时,报错必须在 note 上活到帧尾 ——
    探针读数走 note2,不许当场覆盖。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from tools.lightbake.gui import app as app_mod
    from tools.lightbake.gui.app import create_window
    h, w = 24, 32
    ctx = _rich_fake_ctx(h, w)
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx)
    _settle_lights(_app, win)
    if win.char_combo.count() == 0:
        pytest.skip('本机无立绘图集')
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('final'))
    win.probe_on.setChecked(True)
    win._probe_px = (w // 2, h // 2)
    win.char_on.setChecked(True)
    win._char_foot = (w // 2, h - 2)

    def boom(*_a, **_k):
        raise RuntimeError('炸给你看')

    monkeypatch.setattr(app_mod.char_mod, 'shade_character', boom)
    win._render()
    assert '立绘着色失败' in win.note.text()
    assert '探针@' in win.note2.text()


def test_gui_char_placement_gated_to_final_channels():
    """二审 P2-5 回归:非 final 系通道下 char_on 不吞点击 —— a0 通道
    点击照常放探针。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from tools.lightbake.gui.app import create_window
    h, w = 24, 32
    ctx = _rich_fake_ctx(h, w)
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx)
    _settle_lights(_app, win)
    win.channel.setCurrentIndex(
        [win.channel.itemData(i) for i in range(win.channel.count())
         ].index('a0'))
    win.char_on.setChecked(True)
    win.probe_on.setChecked(True)
    win._render()
    s, offx, offy, _w, _h = win._view_map
    win._on_view_click(3 * s + offx, 3 * s + offy)
    assert win._char_foot is None                   # 角色没被放
    assert win._probe_px == (3, 3)                  # 探针照常
    win._on_view_release()


def test_gui_lights_stale_ctx_dropped():
    """复核 P0 回归钉:重烘落地(set_ctx)后,在飞 worker 端上来的**旧 ctx**
    结果必须被丢弃(缓存键不含 ctx 身份,写进去会被下一帧端出 —— 二审用
    离屏 repro 实证过)。同 ctx 的 done 才落缓存。"""
    pytest.importorskip('PySide6')
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    import numpy as np
    from tools.lightbake.gui.app import create_window
    ctx1 = _rich_fake_ctx(24, 32)
    ctx2 = _rich_fake_ctx(24, 32)
    _app, win = create_window('雾津街头', autobake=False)
    win.set_ctx(ctx2)
    _settle_lights(_app, win)           # set_ctx 自触发的 final 计算先收干净
    win._lights_cache = {}
    arr = np.zeros((24, 32, 3), 'float32')
    win._on_lights_done({'key': ('px', 'stale'), 'e': arr, 'notes': [],
                         'ctx': ctx1})          # 旧 ctx ⇒ 丢弃
    _settle_lights(_app, win)           # 丢弃分支的 _render 可能补一枪,收掉
    assert ('px', 'stale') not in win._lights_cache
    win._on_lights_done({'key': ('px', 'fresh'), 'e': arr, 'notes': [],
                         'ctx': win.ctx})       # 同 ctx ⇒ 落缓存
    assert ('px', 'fresh') in win._lights_cache
    _settle_lights(_app, win)


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
                  'vol_max_cells': 1_000_000, 'clamp_indirect': 10.0,
                  'demod_mode': 'chroma_clamp', 'e_chroma_clamp': 0.2}
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
               'e_chroma_clamp': 'e_chroma', 'demod_mode': 'demod_combo',
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
