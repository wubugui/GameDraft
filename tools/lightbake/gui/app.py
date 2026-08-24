"""编辑器 GUI —— **壳,不是第二个烘焙器**(方案 §11.1)。

硬规矩:GUI 里每一个旋钮背后都是 CLI 也能调到的同一个库函数/同一个参数,
GUI 自己不含一行烘焙逻辑;面板顶部常驻**等价 CLI 命令行**回显 ——
「GUI 里能做、CLI 做不到」= 架构 bug,肉眼可查。

- 参数分两档:
  · **重估级**(亚秒~秒,不 march):天空(§5.12 缓存重估)、去噪趟数 ——
    改了自动重组回帧;
  · **重烘级**(秒~分,要 march):spp/矩 spp/AO spp/体 spp/体密度/格数上限/
    NEE/clamp/含体积 —— 改了点「重烘场景侧」按钮,工作线程重跑
    `bake_scene(write=False)`,跑完全部预览刷新。
- 视口:全部中间结果 + 体切片(y 滑条)+ **最终渲染预览**
  (`preview.shade_final`,§6.1 CPU 镜像唯一实现;时刻预设 + gi/ev 旋钮);
- 首帧:`bake_scene(with_volume=False)` 在工作线程跑,不冻 UI;
- 存回:`input.save_bake_sky`(内部走编辑器统一写盘出口 tools/editor/file_io);
  skybox 路径存**仓库相对路径**;
- 「全量 bake」带上面板全部参数写载荷 + 自检 + report —— 与等价 CLI 同字节。

结构:`create_window(sid, autobake=False)` 出窗不进事件循环(离屏测试用),
`run_gui(sid)` 是 CLI 入口。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from PySide6.QtCore import Qt, QThread, QTimer, Signal          # noqa: E402
from PySide6.QtGui import QImage, QPixmap                       # noqa: E402
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox,  # noqa: E402
                               QDoubleSpinBox, QFileDialog, QFormLayout,
                               QGroupBox, QHBoxLayout, QLabel, QMainWindow,
                               QMessageBox, QPushButton, QScrollArea, QSlider,
                               QSpinBox, QVBoxLayout, QWidget)

from tools.lightbake import input as input_mod                  # noqa: E402
from tools.lightbake import preview as preview_mod              # noqa: E402
from tools.lightbake.const import (AO_SPP, CHAR_VOL_SPP, GATHER_SPP,  # noqa: E402
                                   MOMENT_SPP)
from tools.lightbake.denoise import ATROUS_ITERS, denoise_e     # noqa: E402
from tools.lightbake.encode import LUMA, from_hdr, linear_to_srgb  # noqa: E402
from tools.lightbake.gather import (bent_of_moments, combine_e,     # noqa: E402
                                    compose_sun_e, gather_gain_of,
                                    solve_direct_light, vis_of_normal)
from tools.lightbake.pipeline import bake_scene                 # noqa: E402
from tools.lightbake.sky import make_sky_sampler                # noqa: E402


class FnWorker(QThread):
    """把任意库函数调用丢进工作线程 —— GUI 自己零烘焙逻辑。
    异常必须转成信号(裸抛 ⇒ 界面永久停在「烘焙中」且零提示)。"""

    done = Signal(object)

    def __init__(self, fn):
        super().__init__()
        self._fn = fn

    def run(self) -> None:
        try:
            self.done.emit(self._fn())
        except Exception as exc:                       # noqa: BLE001 — 转信号
            self.done.emit({'error': f'{type(exc).__name__}: {exc}'})


class Recombine(QThread):
    """§5.12 下游后处理(重估级):天空半重组 → 去噪 → 直射光反解 → gain。
    无 march。两段式回报:E 重组先出一帧,太阳几秒后跟上。
    去噪与 pipeline 调**同一份** denoise_e(重估 ≡ 全新 bake,§15)。"""

    partial = Signal(dict)
    done = Signal(dict)

    def __init__(self, ctx: dict, spec: dict, denoise_iters: int):
        super().__init__()
        self.ctx, self.spec = ctx, spec
        self.denoise_iters = denoise_iters

    def run(self) -> None:
        ctx = self.ctx
        inp = ctx['inp']
        sky_of = make_sky_sampler(self.spec, _ROOT)
        e_ind = combine_e(ctx['cache'], sky_of)
        e_ind = denoise_e(e_ind, inp.normal, inp.depth,
                          iters=self.denoise_iters)
        self.partial.emit({'e': e_ind, 'e_ind': e_ind, 'sun': {'found': False},
                           'gain': 1.0, 'spec': self.spec})
        a0f, a1f = ctx['moments_smooth']
        sun = solve_direct_light(inp.normal, a0f, a1f, ctx['hdr_work'],
                                 e_ind, progress=None)
        e = compose_sun_e(e_ind, inp.normal, a0f, a1f, sun)
        gain = gather_gain_of(ctx['hdr_work'], e)
        self.done.emit({'e': (e * gain).astype(np.float32),
                        'e_ind': (e_ind * gain).astype(np.float32),
                        'sun': sun, 'gain': gain, 'spec': self.spec})


def _g2c(x, lo=0.0, hi=1.0):
    v = np.clip((np.asarray(x, np.float32) - lo) / max(hi - lo, 1e-9), 0, 1)
    return np.repeat(v[..., None], 3, -1)


class Win(QMainWindow):
    def __init__(self, sid: str, autobake: bool = True) -> None:
        super().__init__()
        self.sid = sid
        self.setWindowTitle(f'lightbake · {sid}')
        self.view = QLabel('烘焙中(首次需 march,不冻界面)……')
        self.view.setAlignment(Qt.AlignCenter)
        self.view.setMinimumSize(720, 405)
        self.status = QLabel('')
        self.status.setWordWrap(True)

        # ---------------- 视口通道 ----------------
        self.channel = QComboBox()
        self.channel.addItems([
            '最终渲染预览(§6.1 镜像)', 'base·E(原画重构)', 'E(最终,亮度)',
            'E(最终,彩色)', 'E间接', 'E直接(太阳反解)', 'base 亮度(log2)',
            'base 色度', '2·a₀(天穹矩)', 'V(N=up)', 'Bent normal',
            'a₁(+0.5)', 'AO(局部)', '深度', '法线', '去霾原画',
            '体·天穹 2a₀ 切片', '体·AO 切片', '体·GI 亮度切片',
            '体·validity 切片'])
        self.vol_slice = QSlider(Qt.Horizontal)
        self.vol_slice.setRange(0, 100)
        self.vol_slice.setValue(12)

        # ---------------- 渲染预览组 ----------------
        self.preset = QComboBox()
        self.preset.addItems([p[0] for p in preview_mod.TIME_PRESETS])
        self.gi = self._dspin(0.15, step=0.05, hi=1.0)
        self.ev = self._dspin(0.0, step=0.5, lo=-6.0, hi=8.0)

        # ---------------- 天空组(重估级) ----------------
        self.mode = QComboBox()
        self.mode.addItems(['color', 'skybox'])
        self.r = self._dspin(1.0)
        self.g = self._dspin(1.0)
        self.b = self._dspin(1.0)
        self.inten = self._dspin(0.05, step=0.01)
        self.sky_file = QLabel('—')
        pick = QPushButton('选 skybox…')
        pick.clicked.connect(self._pick_file)

        # ---------------- 去噪组(重估级) ----------------
        self.denoise_on = QCheckBox('引导去噪(à-trous)')
        self.denoise_on.setChecked(True)
        self.denoise_iters = self._ispin(ATROUS_ITERS, 0, 6)

        # ---------------- 采样质量组(重烘级) ----------------
        self.spp = self._ispin(GATHER_SPP, 1, 4096)
        self.moment_spp = self._ispin(MOMENT_SPP, 8, 4096)
        self.ao_spp = self._ispin(AO_SPP, 8, 4096)
        self.vol_spp = self._ispin(CHAR_VOL_SPP, 8, 4096)
        self.vol_density = self._dspin(0.0, step=0.5, hi=64.0)   # 0 = 缺省
        self.vol_max_cells = self._ispin(0, 0, 50_000_000)       # 0 = 缺省
        self.nee_on = QCheckBox('NEE+MIS 光源采样')
        self.nee_on.setChecked(True)
        self.clamp = self._dspin(0.0, step=0.5, hi=1e6)          # 0 = 关
        self.with_volume = QCheckBox('含体积数据(预览重烘也算体)')

        # ---------------- 动作 ----------------
        self.rebake_btn = QPushButton('重烘场景侧(预览,不写盘)')
        self.rebake_btn.clicked.connect(self._preview_rebake)
        save = QPushButton('存回场景 JSON(lighting.bakeSky)')
        save.clicked.connect(self._save_sky)
        self.bake_btn = QPushButton('全量 bake(写载荷 + 自检 + report)')
        self.bake_btn.clicked.connect(self._full_bake)
        self.cli_line = QLabel('')
        self.cli_line.setWordWrap(True)
        self.cli_line.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.cli_line.setStyleSheet('font-family: Consolas, monospace;'
                                    'color: #777; font-size: 11px;')

        side = QVBoxLayout()

        def group(title, rows):
            gb = QGroupBox(title)
            f = QFormLayout()
            for label, w_ in rows:
                if label is None:
                    f.addRow(w_)
                else:
                    f.addRow(label, w_)
            gb.setLayout(f)
            side.addWidget(gb)

        group('视口', [('通道', self.channel), ('体切片 y%', self.vol_slice)])
        group('渲染预览(§6.1 镜像)', [('时刻预设', self.preset),
                                       ('gi', self.gi), ('ev', self.ev)])
        group('烘焙期天空(重估级)', [('模式', self.mode), ('R', self.r),
                                      ('G', self.g), ('B', self.b),
                                      ('强度', self.inten),
                                      (None, pick), (None, self.sky_file)])
        group('去噪(重估级)', [(None, self.denoise_on),
                                ('趟数', self.denoise_iters)])
        group('采样质量(重烘级)', [
            ('场景 E spp', self.spp), ('遮蔽矩 spp(双侧同值)', self.moment_spp),
            ('AO spp', self.ao_spp), ('体 AO/GI spp', self.vol_spp),
            ('体密度(0=缺省)', self.vol_density),
            ('体格数上限(0=缺省)', self.vol_max_cells),
            (None, self.nee_on), ('clamp(0=关)', self.clamp),
            (None, self.with_volume)])
        side.addWidget(self.rebake_btn)
        side.addWidget(save)
        side.addWidget(self.bake_btn)
        side.addWidget(QLabel('等价 CLI:'))
        side.addWidget(self.cli_line)
        side.addWidget(self.status)
        side.addStretch(1)

        panel = QWidget()
        panel.setLayout(side)
        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(330)
        lay = QHBoxLayout()
        lay.addWidget(self.view, 1)
        lay.addWidget(scroll)
        root = QWidget()
        root.setLayout(lay)
        self.setCentralWidget(root)

        self.ctx: dict | None = None
        self.result: dict | None = None
        self.worker: Recombine | None = None
        self.bake_worker: FnWorker | None = None
        self._base_cache: tuple | None = None
        self.debounce = QTimer(self)
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(300)
        self.debounce.timeout.connect(self._kick)
        for w_ in (self.r, self.g, self.b, self.inten, self.denoise_iters):
            w_.valueChanged.connect(self.debounce.start)
        self.mode.currentIndexChanged.connect(self.debounce.start)
        self.denoise_on.stateChanged.connect(self.debounce.start)
        for w_ in (self.channel, self.preset):
            w_.currentIndexChanged.connect(self._render)
        for w_ in (self.gi, self.ev):
            w_.valueChanged.connect(self._render)
        self.vol_slice.valueChanged.connect(self._render)
        for w_ in (self.spp, self.moment_spp, self.ao_spp, self.vol_spp,
                   self.vol_max_cells, self.denoise_iters):
            w_.valueChanged.connect(self._refresh_cli)
        for w_ in (self.vol_density, self.clamp, self.inten):
            w_.valueChanged.connect(self._refresh_cli)
        self.nee_on.stateChanged.connect(self._refresh_cli)
        self.denoise_on.stateChanged.connect(self._refresh_cli)
        self._refresh_cli()
        if autobake:
            QTimer.singleShot(50, self._initial_bake)

    # ---------------- 控件工厂 ----------------
    @staticmethod
    def _dspin(v: float, step: float = 0.05, lo: float = 0.0,
               hi: float = 100.0) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setDecimals(3)
        s.setSingleStep(step)
        s.setValue(v)
        return s

    @staticmethod
    def _ispin(v: int, lo: int, hi: int) -> QSpinBox:
        s = QSpinBox()
        s.setRange(lo, hi)
        s.setValue(int(v))
        return s

    # ---------------- 参数面(壳的核心:与 CLI 同一组 kwargs) ----------------
    def _bake_kwargs(self) -> dict:
        """面板 → bake_scene kwargs。与 `python -m tools.lightbake bake` 的
        参数一一对应(_cli_line 是它的镜像,肉眼可核对)。"""
        kw = dict(spp=self.spp.value(), moment_spp=self.moment_spp.value(),
                  ao_spp=self.ao_spp.value(), vol_spp=self.vol_spp.value(),
                  nee=self.nee_on.isChecked(),
                  denoise=self.denoise_on.isChecked(),
                  denoise_iters=(self.denoise_iters.value()
                                 if self.denoise_on.isChecked() else 0))
        if self.vol_density.value() > 0:
            kw['vol_density'] = self.vol_density.value()
        if self.vol_max_cells.value() > 0:
            kw['vol_max_cells'] = self.vol_max_cells.value()
        if self.clamp.value() > 0:
            kw['clamp_indirect'] = self.clamp.value()
        return kw

    def _cli_line_text(self) -> str:
        kw = self._bake_kwargs()
        parts = [f'python -m tools.lightbake bake --scene {self.sid}',
                 f"--spp {kw['spp']}", f"--moment-spp {kw['moment_spp']}",
                 f"--ao-spp {kw['ao_spp']}", f"--vol-spp {kw['vol_spp']}"]
        if 'vol_density' in kw:
            parts.append(f"--vol-density {kw['vol_density']:g}")
        if 'vol_max_cells' in kw:
            parts.append(f"--vol-max-cells {kw['vol_max_cells']}")
        if not kw['nee']:
            parts.append('--no-nee')
        if 'clamp_indirect' in kw:
            parts.append(f"--clamp-indirect {kw['clamp_indirect']:g}")
        if not kw['denoise'] or kw['denoise_iters'] == 0:
            parts.append('--no-denoise')
        elif kw['denoise_iters'] != ATROUS_ITERS:
            parts.append(f"--denoise-iters {kw['denoise_iters']}")
        return ' '.join(parts)

    def _refresh_cli(self, *_a) -> None:
        self.cli_line.setText(self._cli_line_text())

    # ---------------- 数据流 ----------------
    def _initial_bake(self) -> None:
        self._start_bake(with_volume=False,
                         label='首帧烘焙中(场景侧)……')

    def _preview_rebake(self) -> None:
        self._start_bake(with_volume=self.with_volume.isChecked(),
                         label='重烘场景侧(预览)……')

    def _start_bake(self, with_volume: bool, label: str) -> None:
        if self.bake_worker and self.bake_worker.isRunning():
            self.status.setText('已有烘焙在跑,等它先。')
            return
        self.status.setText(label + f'\n{self._cli_line_text()}')
        kw = self._bake_kwargs()
        # 预览重烘含体积时:write/checks/report 全关(§11.1:预览不落盘)
        self.bake_worker = FnWorker(
            lambda: bake_scene(self.sid, with_volume=with_volume,
                               write=False, run_checks=False,
                               make_report=False,
                               sky_override=self._spec() if self.ctx else None,
                               quiet=True, **kw))
        self.bake_worker.done.connect(self.set_ctx)
        self.bake_worker.start()

    def set_ctx(self, ctx: dict) -> None:
        """接一份 pipeline ctx(离屏测试也从这里注入)。"""
        if ctx.get('error'):
            self.view.setText(f'烘焙失败:{ctx["error"]}')
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        self.ctx = ctx
        self._base_cache = None
        spec = ctx.get('sky_spec') or {}
        self.mode.setCurrentText(spec.get('mode', 'color'))
        c = spec.get('color', [1, 1, 1])
        self.r.setValue(float(c[0]))
        self.g.setValue(float(c[1]))
        self.b.setValue(float(c[2]))
        self.inten.setValue(float(spec.get('intensity', 0.05)))
        if spec.get('file'):
            self.sky_file.setText(str(spec['file']))
        self.result = {'e': ctx.get('e'), 'e_ind': ctx.get('e_ind'),
                       'sun': ctx.get('sun', {'found': False}),
                       'gain': ctx.get('gain', 1.0), 'spec': spec}
        self.status.setText('就绪。重估级旋钮即调即回帧;'
                            '重烘级旋钮改完点「重烘场景侧」。')
        self._render()

    def _spec(self) -> dict:
        if self.mode.currentText() == 'skybox' and self.sky_file.text() != '—':
            return {'mode': 'skybox', 'file': self.sky_file.text(),
                    'intensity': self.inten.value()}
        return {'mode': 'color',
                'color': [self.r.value(), self.g.value(), self.b.value()],
                'intensity': self.inten.value()}

    def _kick(self) -> None:
        if self.ctx is None or 'cache' not in self.ctx:
            return
        if self.worker and self.worker.isRunning():
            self.debounce.start()                  # 正忙,稍后再试
            return
        iters = (self.denoise_iters.value()
                 if self.denoise_on.isChecked() else 0)
        self.worker = Recombine(self.ctx, self._spec(), iters)
        self.worker.partial.connect(self._on_done)
        self.worker.done.connect(self._on_done)
        self.worker.start()

    def _on_done(self, result: dict) -> None:
        self.result = result
        self._render()

    # ---------------- 渲染(全部只读 ctx 产物,零烘焙逻辑) ----------------
    def _placeholder(self, msg: str) -> np.ndarray:
        img = np.full((90, 160, 3), 0.18, np.float32)
        self.status.setText(msg)
        return img

    def _vol_slice_img(self, kind: str) -> np.ndarray:
        vol = (self.ctx or {}).get('volume')
        if not vol:
            return self._placeholder('体数据未烘 —— 勾「含体积数据」后点'
                                     '「重烘场景侧」')
        g = vol['grid']
        nx, ny, nz = g['nx'], g['ny'], g['nz']
        iy = min(ny - 1, round(self.vol_slice.value() / 100 * (ny - 1)))
        raw = vol['raw']
        if kind == 'sky':
            sl = raw['sky_a0'].reshape(nx, ny, nz)[:, iy, :].T * 2.0
            lo, hi = 0.0, 1.0
        elif kind == 'ao':
            sl = raw['ao_a0'].reshape(nx, ny, nz)[:, iy, :].T
            lo, hi = 0.0, 1.0
        elif kind == 'gi':
            sl = np.log2(np.maximum(
                (raw['gi_a0'] @ LUMA).reshape(nx, ny, nz)[:, iy, :].T, 1e-4))
            lo, hi = float(sl.min()), float(sl.max()) + 1e-6
        else:
            sl = raw['invalid'].reshape(nx, ny, nz)[:, iy, :].T.astype(
                np.float32)
            lo, hi = 0.0, 1.0
        return _g2c(np.kron(sl, np.ones((4, 4))), lo, hi)

    def _channel_img(self) -> np.ndarray:
        ctx, res = self.ctx, self.result
        name = self.channel.currentText()
        a0f, a1f = ctx['moments_smooth']

        def need(*keys):
            missing = [k for k in keys if ctx.get(k) is None]
            return missing

        if name.startswith('最终渲染'):
            if need('e_q', 'inp'):
                return self._placeholder('该通道需要完整 ctx(重烘后可用)')
            if self._base_cache is None:
                self._base_cache = preview_mod.base_of_ctx(ctx)
            base, _bg = self._base_cache
            pi = self.preset.currentIndex()
            _n, sky_def, sun_dir, _ev = preview_mod.TIME_PRESETS[pi]
            return preview_mod.shade_final(
                base, ctx['e_q'], a0f, a1f, ctx['normal'], sky_def, sun_dir,
                gi=self.gi.value(), ev=self.ev.value())
        if name.startswith('base·E'):
            return linear_to_srgb(from_hdr(ctx['hdr_work']))
        if name.startswith('E(最终,亮度'):
            lum = res['e'] @ LUMA
            return _g2c(lum, 0, float(np.percentile(lum, 99)))
        if name.startswith('E(最终,彩色'):
            return linear_to_srgb(from_hdr(res['e']))
        if name == 'E间接':
            e_ind = res.get('e_ind')
            if e_ind is None:
                return self._placeholder('E间接 需要重估一轮(动一下天空旋钮)')
            return linear_to_srgb(from_hdr(e_ind * res.get('gain', 1.0)
                                           if res.get('gain', 1.0) != 1.0
                                           else e_ind))
        if name.startswith('E直接'):
            e_ind = res.get('e_ind')
            if e_ind is None or res.get('e') is None:
                return self._placeholder('E直接 需要重估一轮')
            d = np.maximum((res['e'] - e_ind) @ LUMA, 0)
            return _g2c(d, 0, max(float(np.percentile(d, 99)), 1e-6))
        if name.startswith('base 亮度'):
            if need('e_q', 'inp'):
                return self._placeholder('base 需要完整 ctx')
            if self._base_cache is None:
                self._base_cache = preview_mod.base_of_ctx(ctx)
            lum = np.log2(np.maximum(self._base_cache[0] @ LUMA, 1e-6))
            return _g2c(lum, float(np.percentile(lum, 1)),
                        float(np.percentile(lum, 99)))
        if name.startswith('base 色度'):
            if need('e_q', 'inp'):
                return self._placeholder('base 需要完整 ctx')
            if self._base_cache is None:
                self._base_cache = preview_mod.base_of_ctx(ctx)
            b = self._base_cache[0]
            return np.clip(b / np.maximum(b.max(-1, keepdims=True), 1e-6),
                           0, 1)
        if name.startswith('2·a₀'):
            return _g2c(a0f * 2.0)
        if name.startswith('V(N=up'):
            n = np.broadcast_to(np.array([0, 1, 0], np.float32),
                                a0f.shape + (3,))
            return _g2c(vis_of_normal(a0f, a1f, n))
        if name.startswith('Bent'):
            return np.clip(bent_of_moments(a1f, ctx['normal']) * 0.5 + 0.5,
                           0, 1)
        if name.startswith('a₁'):
            return np.clip(a1f + 0.5, 0, 1)
        if name.startswith('AO'):
            return _g2c(ctx['ao'])
        if name == '深度':
            if need('inp'):
                return self._placeholder('深度需要完整 ctx')
            d = ctx['inp'].depth
            return _g2c(d, float(d.min()), float(d.max()))
        if name == '法线':
            return np.clip(ctx['normal'] * 0.5 + 0.5, 0, 1)
        if name == '去霾原画':
            if ctx.get('lin_dehazed') is None:
                return self._placeholder('去霾图需要完整 ctx')
            return linear_to_srgb(ctx['lin_dehazed'])
        if name.startswith('体·天穹'):
            return self._vol_slice_img('sky')
        if name.startswith('体·AO'):
            return self._vol_slice_img('ao')
        if name.startswith('体·GI'):
            return self._vol_slice_img('gi')
        if name.startswith('体·validity'):
            return self._vol_slice_img('inv')
        return self._placeholder(f'未知通道 {name}')

    def _render(self, *_a) -> None:
        if self.ctx is None or self.result is None:
            return
        try:
            img = self._channel_img()
        except Exception as exc:                       # noqa: BLE001 — 显示不许炸
            img = self._placeholder(f'渲染失败:{type(exc).__name__}: {exc}')
        u8 = np.ascontiguousarray(
            np.round(np.clip(img, 0, 1) * 255).astype(np.uint8))
        h, w = u8.shape[:2]
        qi = QImage(u8.data, w, h, w * 3, QImage.Format_RGB888)
        self.view.setPixmap(QPixmap.fromImage(qi).scaled(
            self.view.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

    # ---------------- 动作 ----------------
    def _pick_file(self) -> None:
        f, _ = QFileDialog.getOpenFileName(self, '选 skybox', str(_ROOT),
                                           'HDR/图像 (*.hdr *.png *.jpg)')
        if not f:
            return
        p = Path(f)
        try:
            f = p.relative_to(_ROOT).as_posix()
        except ValueError:
            QMessageBox.warning(self, 'lightbake',
                                'skybox 在仓库之外 —— 存的是绝对路径,'
                                '别的机器上不可复现,建议先把文件放进仓库。')
        self.sky_file.setText(str(f))
        self.debounce.start()

    def _save_sky(self) -> None:
        j = input_mod.save_bake_sky(self.sid, self._spec())
        QMessageBox.information(self, 'lightbake',
                                f'已存回 {j.name} 的 lighting.bakeSky。\n'
                                'CLI 重烘读的就是这份 —— GUI 里看到什么,'
                                '无头重烘就出什么。')

    def _full_bake(self) -> None:
        if self.bake_worker and self.bake_worker.isRunning():
            return
        self.bake_btn.setEnabled(False)
        self.bake_btn.setText('烘焙中……')
        self.status.setText('全量 bake:\n' + self._cli_line_text())
        spec = self._spec()
        kw = self._bake_kwargs()
        self.bake_worker = FnWorker(
            lambda: bake_scene(self.sid, sky_override=spec, quiet=False, **kw))
        self.bake_worker.done.connect(self._on_full_bake_done)
        self.bake_worker.start()

    def _on_full_bake_done(self, ctx: dict) -> None:
        self.bake_btn.setEnabled(True)
        self.bake_btn.setText('全量 bake(写载荷 + 自检 + report)')
        if ctx.get('error'):
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        if ctx.get('failed'):
            QMessageBox.warning(self, 'lightbake',
                                '自检有红,产物未落盘;report 已生成,详见预览目录。')
            return
        self.set_ctx(ctx)
        import webbrowser
        webbrowser.open((ctx['out_dir'] / 'preview' / 'report.html').as_uri())

    def closeEvent(self, event) -> None:                # noqa: N802 — Qt 命名
        for w_ in (self.worker, self.bake_worker):
            if w_ and w_.isRunning():
                w_.wait()                               # 别销毁活线程
        event.accept()


def create_window(sid: str, autobake: bool = True) -> tuple[QApplication, Win]:
    """出窗不进事件循环(离屏测试从这里进)。"""
    app = QApplication.instance() or QApplication(sys.argv)
    win = Win(sid, autobake=autobake)
    return app, win


def run_gui(sid: str) -> int:
    app, win = create_window(sid, autobake=True)
    win.resize(1280, 720)
    win.show()
    return app.exec()
