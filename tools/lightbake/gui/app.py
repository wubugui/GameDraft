"""编辑器 GUI —— **壳,不是第二个烘焙器**(方案 §11.1)。

硬规矩:GUI 里每一个旋钮背后都是 CLI 也能调到的同一个库函数/同一个参数,
GUI 自己不含一行烘焙逻辑,**连编排都不含**:§5.12 的重估序列走
`pipeline.recombine_sky`(唯一编排,自检 #12(c) 钉全链逐位)。面板顶部
常驻等价 CLI 命令行回显(含 `--sky`)——「GUI 里能做、CLI 做不到」= 架构
bug,肉眼可查。`with_volume` 复选是唯一例外:只用于**不落盘的预览重烘**,
不改任何产物,CLI 侧由 bake(恒含体)/check/report 工作流编码。

- 参数分两档:重估级(天空/去噪趟数,亚秒~秒回帧)与重烘级(work_w/spp/
  矩/AO/体/密度/上限/NEE/clamp/no-gi,点「重烘场景侧」入线程);
- 视口:原画 / 全部中间结果 / 体切片(y 滑条)/ 最终渲染预览
  (`preview.sky_response`+`compose_final`,§6.1 唯一实现;时刻预设含
  「场景自身 lighting.sky」,gi/ev 走缓存的便宜半,毫秒级);
- 进度与取消:pipeline 的 progress 回调进状态栏,取消按钮随时中断;
- 天空 spec 往返保真:面板是**在读入 spec 上打补丁**,GUI 不认识的键原样
  保留(editor-tools 往返铁律);存回走 `input.save_bake_sky`
  (内部走编辑器统一写盘出口 tools/editor/file_io);
- 自检红:照 CLI 口径 —— 更要开 report,弹框列出红项。

结构:`create_window(sid, autobake=False)` 出窗不进事件循环(离屏测试用),
`run_gui(sid, threads=0)` 是 CLI 入口。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from PySide6.QtCore import (Qt, QSignalBlocker, QThread, QTimer,  # noqa: E402
                            Signal)
from PySide6.QtGui import QImage, QPixmap                       # noqa: E402
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox,  # noqa: E402
                               QDoubleSpinBox, QFileDialog, QFormLayout,
                               QGroupBox, QHBoxLayout, QLabel, QMainWindow,
                               QMessageBox, QPushButton, QScrollArea, QSlider,
                               QSpinBox, QVBoxLayout, QWidget)

from tools.lightbake import input as input_mod                  # noqa: E402
from tools.lightbake import preview as preview_mod              # noqa: E402
from tools.lightbake.const import (AO_SPP, CHAR_VOL_SPP, GATHER_SPP,  # noqa: E402
                                   MOMENT_SPP, WORK_W)
from tools.lightbake.denoise import ATROUS_ITERS                # noqa: E402
from tools.lightbake.encode import LUMA, from_hdr, linear_to_srgb  # noqa: E402
from tools.lightbake.gather import bent_of_moments, vis_of_normal  # noqa: E402
from tools.lightbake.pipeline import bake_scene, recombine_sky  # noqa: E402
from tools.lightbake.trace import set_threads                   # noqa: E402


class _Cancelled(RuntimeError):
    pass


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
        except _Cancelled:
            self.done.emit({'error': '已取消'})
        except Exception as exc:                       # noqa: BLE001 — 转信号
            self.done.emit({'error': f'{type(exc).__name__}: {exc}'})


class Recombine(QThread):
    """§5.12 重估(重估级):**只转发**到 pipeline.recombine_sky ——
    编排一行不抄(审查 [2])。两段式回帧:E 先出(partial,pre-gain、
    未标定尺度),太阳几秒后跟上(done)。异常照 FnWorker 规矩转信号。"""

    partial = Signal(dict)
    done = Signal(dict)

    def __init__(self, ctx: dict, spec: dict, denoise_iters: int,
                 threads: int):
        super().__init__()
        self.ctx, self.spec = ctx, spec
        self.denoise_iters = denoise_iters
        self.threads = threads

    def run(self) -> None:
        try:
            set_threads(self.threads)                  # numba 线程数是线程局部的
            rec = recombine_sky(
                self.ctx, self.spec, denoise_iters=self.denoise_iters,
                on_partial=lambda e_ind: self.partial.emit(
                    {'e': e_ind, 'e_ind': e_ind, 'sun': {'found': False},
                     'gain': 1.0, 'spec': self.spec, 'calibrated': False}))
            rec = dict(rec)
            rec.pop('sky_of', None)
            rec['spec'] = self.spec
            rec['calibrated'] = True
            self.done.emit(rec)
        except Exception as exc:                       # noqa: BLE001 — 转信号
            self.done.emit({'error': f'{type(exc).__name__}: {exc}'})


def _g2c(x, lo=0.0, hi=1.0):
    v = np.clip((np.asarray(x, np.float32) - lo) / max(hi - lo, 1e-9), 0, 1)
    return np.repeat(v[..., None], 3, -1)


#: 视口通道:(稳定 key, 显示文案)。分发走 key,改文案不碎逻辑(审查 [20])。
_CHANNELS = [
    ('final', '最终渲染预览(§6.1 镜像)'),
    ('painting', '原画(输入)'),
    ('recon', 'base·E_q(gi=1 无天光 ≡ 原画重构)'),
    ('dehazed_hdr', '去霾重构(hdr_work 显示)'),
    ('e_lum', 'E(最终,亮度)'),
    ('e_rgb', 'E(最终,彩色)'),
    ('e_ind', 'E间接'),
    ('e_dir', 'E直接(太阳反解)'),
    ('base_lum', 'base 亮度(log2)'),
    ('base_chroma', 'base 色度'),
    ('a0', '2·a₀(天穹矩)'),
    ('vis_up', 'V(N=up)'),
    ('bent', 'Bent normal'),
    ('a1', 'a₁(+0.5)'),
    ('ao', 'AO(局部)'),
    ('depth', '深度'),
    ('normal', '法线'),
    ('dehazed', '去霾原画'),
    ('vol_sky', '体·天穹 2a₀ 切片'),
    ('vol_ao', '体·AO 切片'),
    ('vol_gi', '体·GI 亮度切片'),
    ('vol_inv', '体·validity 切片'),
]


class Win(QMainWindow):
    progressed = Signal(str, int, int)

    def __init__(self, sid: str, autobake: bool = True,
                 threads: int = 0) -> None:
        super().__init__()
        self.sid = sid
        self._threads = int(threads)
        self.setWindowTitle(f'lightbake · {sid}')
        self.view = QLabel('烘焙中(首次需 march,不冻界面)……')
        self.view.setAlignment(Qt.AlignCenter)
        self.view.setMinimumSize(720, 405)
        self.note = QLabel('')                # 通道级提示(占位原因等)
        self.note.setStyleSheet('color:#997; font-size: 11px;')
        self.status = QLabel('')
        self.status.setWordWrap(True)

        # ---------------- 视口通道 ----------------
        self.channel = QComboBox()
        for key, label in _CHANNELS:
            self.channel.addItem(label, key)
        self.vol_slice = QSlider(Qt.Horizontal)
        self.vol_slice.setRange(0, 100)
        self.vol_slice.setValue(12)

        # ---------------- 渲染预览组 ----------------
        self.preset = QComboBox()
        for p in preview_mod.TIME_PRESETS:
            self.preset.addItem(p[0])
        self.preset.addItem('场景自身 lighting.sky')
        self.gi = self._dspin(0.15, step=0.05, hi=1.0)
        self.ev = self._dspin(0.0, step=0.5, lo=-6.0, hi=8.0)

        # ---------------- 天空组(重估级) ----------------
        self.mode = QComboBox()
        self.mode.addItems(['color', 'skybox'])
        self.r = self._dspin(1.0, decimals=6)
        self.g = self._dspin(1.0, decimals=6)
        self.b = self._dspin(1.0, decimals=6)
        self.inten = self._dspin(0.05, step=0.01, decimals=6)
        self.sky_file = QLabel('—')
        pick = QPushButton('选 skybox…')
        pick.clicked.connect(self._pick_file)

        # ---------------- 去噪组(重估级) ----------------
        self.denoise_on = QCheckBox('引导去噪(à-trous)')
        self.denoise_on.setChecked(True)
        self.denoise_iters = self._ispin(ATROUS_ITERS, 0, 8)

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
        self.work_w = self._ispin(WORK_W, 128, 4096)
        self.no_gi = QCheckBox('不烘体 GI(--no-gi)')
        self.heavy_on = QCheckBox('全量 bake 跑重档自检(#8 双烘逐位,加倍耗时)')

        # ---------------- 动作 ----------------
        self.rebake_btn = QPushButton('重烘场景侧(预览,不写盘)')
        self.rebake_btn.clicked.connect(self._preview_rebake)
        save = QPushButton('存回场景 JSON(lighting.bakeSky)')
        save.clicked.connect(self._save_sky)
        save_bp = QPushButton('存回场景 JSON(lighting.bakeParams)')
        save_bp.clicked.connect(self._save_bake_params)
        self.bake_btn = QPushButton('全量 bake(写载荷 + 自检 + report)')
        self.bake_btn.clicked.connect(self._full_bake)
        self.cancel_btn = QPushButton('取消当前烘焙')
        self.cancel_btn.clicked.connect(self._cancel)
        self.cancel_btn.setEnabled(False)
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
            ('工作分辨率宽', self.work_w),
            ('场景 E spp', self.spp), ('遮蔽矩 spp(双侧同值)', self.moment_spp),
            ('AO spp', self.ao_spp), ('体 AO/GI spp', self.vol_spp),
            ('体密度(0=缺省)', self.vol_density),
            ('体格数上限(0=缺省)', self.vol_max_cells),
            (None, self.nee_on), ('clamp(0=关)', self.clamp),
            (None, self.no_gi), (None, self.with_volume),
            (None, self.heavy_on)])
        side.addWidget(self.rebake_btn)
        side.addWidget(save)
        side.addWidget(save_bp)
        side.addWidget(self.bake_btn)
        side.addWidget(self.cancel_btn)
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
        view_col = QVBoxLayout()
        view_col.addWidget(self.view, 1)
        view_col.addWidget(self.note)
        vc = QWidget()
        vc.setLayout(view_col)
        lay = QHBoxLayout()
        lay.addWidget(vc, 1)
        lay.addWidget(scroll)
        root = QWidget()
        root.setLayout(lay)
        self.setCentralWidget(root)

        self.ctx: dict | None = None
        self.result: dict | None = None
        self.worker: Recombine | None = None
        self.bake_worker: FnWorker | None = None
        self._retired: list[QThread] = []
        self._cancel_flag = False
        self._base_cache: tuple | None = None
        self._sky_raw: dict = {}
        self._sky_resp_cache: dict = {}
        self._gi_slice_range: tuple | None = None
        self.progressed.connect(self._on_progress)
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
                   self.vol_max_cells, self.denoise_iters, self.work_w):
            w_.valueChanged.connect(self._refresh_cli)
        for w_ in (self.vol_density, self.clamp, self.inten,
                   self.r, self.g, self.b):
            w_.valueChanged.connect(self._refresh_cli)
        for w_ in (self.nee_on, self.denoise_on, self.no_gi):
            w_.stateChanged.connect(self._refresh_cli)
        self.mode.currentIndexChanged.connect(self._refresh_cli)
        self._refresh_cli()
        if autobake:
            QTimer.singleShot(50, self._initial_bake)

    # ---------------- 控件工厂 ----------------
    @staticmethod
    def _dspin(v: float, step: float = 0.05, lo: float = 0.0,
               hi: float = 100.0, decimals: int = 3) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setDecimals(decimals)
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
        """面板 → bake_scene kwargs(纯 kwargs,可原样回灌;与
        `python -m tools.lightbake bake` 一一对应,_cli_line 是它的镜像)。"""
        kw = dict(work_w=self.work_w.value(),
                  spp=self.spp.value(), moment_spp=self.moment_spp.value(),
                  ao_spp=self.ao_spp.value(), vol_spp=self.vol_spp.value(),
                  no_gi=self.no_gi.isChecked(),
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
        if kw['work_w'] != WORK_W:
            parts.append(f"--work-w {kw['work_w']}")
        if kw['no_gi']:
            parts.append('--no-gi')
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
        # 天空必须进等价行:GUI 的 bake 无条件带 sky_override(§11.1「肉眼
        # 可查」—— 吞掉它,复制这行烘出来的是另一个东西,审查抓过)
        parts.append("--sky '" + json.dumps(self._spec(), ensure_ascii=False,
                                            separators=(',', ':')) + "'")
        return ' '.join(parts)

    def _refresh_cli(self, *_a) -> None:
        self.cli_line.setText(self._cli_line_text())

    # ---------------- 数据流 ----------------
    def _initial_bake(self) -> None:
        self._start_bake(with_volume=False, sky_override=None,
                         label='首帧烘焙中(场景侧)……')

    def _preview_rebake(self) -> None:
        self._start_bake(with_volume=self.with_volume.isChecked(),
                         sky_override=self._spec() if self.ctx else None,
                         label='重烘场景侧(预览)……')

    def _progress_cb(self, stage: str, i: int, n: int) -> None:
        """跑在工作线程里:发进度信号 + 响应取消(审查 [8])。"""
        if self._cancel_flag:
            raise _Cancelled('用户取消')
        if i == n or i % max(1, n // 8) == 0:
            self.progressed.emit(stage, i, n)

    def _on_progress(self, stage: str, i: int, n: int) -> None:
        self.status.setText(f'烘焙中:{stage} {i}/{n}')

    def _launch(self, worker: QThread) -> None:
        """线程押退休名单,finished 后再放(审查 [17]:done.emit 后立刻被
        覆盖有销毁竞态)。"""
        self._retired.append(worker)
        worker.finished.connect(
            lambda w=worker: self._retired.remove(w)
            if w in self._retired else None)
        worker.start()

    def _start_bake(self, with_volume: bool, sky_override: dict | None,
                    label: str) -> None:
        if self.bake_worker and self.bake_worker.isRunning():
            self.status.setText('已有烘焙在跑,等它先(或点取消)。')
            return
        self.status.setText(label + f'\n{self._cli_line_text()}')
        self._cancel_flag = False
        self.cancel_btn.setEnabled(True)
        kw = self._bake_kwargs()          # 主线程快照 —— 工作线程不读控件
        threads = self._threads

        def job():
            set_threads(threads)          # numba 线程数是线程局部的(审查 [3])
            return bake_scene(self.sid, with_volume=with_volume,
                              write=False, run_checks=False,
                              make_report=False, sky_override=sky_override,
                              quiet=True, progress_cb=self._progress_cb, **kw)

        self.bake_worker = FnWorker(job)
        self.bake_worker.done.connect(self.set_ctx)
        self._launch(self.bake_worker)

    def _cancel(self) -> None:
        self._cancel_flag = True
        self.status.setText('取消请求已发出,等当前阶段收尾……')

    def set_ctx(self, ctx: dict) -> None:
        """接一份 pipeline ctx(离屏测试也从这里注入)。"""
        self.cancel_btn.setEnabled(False)
        if ctx.get('error'):
            # 保留旧视口内容,只报错(审查 [26]:清视口会让错误显得凭空消失)
            self.status.setText(f'烘焙失败:{ctx["error"]}')
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        self.ctx = ctx
        self._base_cache = None
        self._sky_resp_cache.clear()
        self._gi_slice_range = None
        spec = dict(ctx.get('sky_spec') or {})
        spec.pop('_source', None)
        self._sky_raw = spec              # 往返保真的底稿(审查 [10])
        # 程序化回填不触发重估(审查 [12]:QSignalBlocker)
        blockers = [QSignalBlocker(w) for w in
                    (self.mode, self.r, self.g, self.b, self.inten)]
        self.mode.setCurrentText(spec.get('mode', 'color'))
        c = spec.get('color', [1, 1, 1])
        self.r.setValue(float(c[0]))
        self.g.setValue(float(c[1]))
        self.b.setValue(float(c[2]))
        self.inten.setValue(float(spec.get('intensity', 0.05)))
        del blockers
        if spec.get('file'):
            self.sky_file.setText(str(spec['file']))
        # 质量面板回填为**决议后**的值(场景 bakeParams 生效时面板如实反映;
        # 面板此后永远显式传参 = 覆盖层)。程序化回填不触发重估/CLI 抖动。
        bp = ctx.get('bake_params') or {}
        if bp:
            blk2 = [QSignalBlocker(w) for w in
                    (self.work_w, self.spp, self.moment_spp, self.ao_spp,
                     self.vol_spp, self.vol_density, self.vol_max_cells,
                     self.nee_on, self.clamp, self.no_gi, self.denoise_on,
                     self.denoise_iters)]
            self.work_w.setValue(int(bp.get('work_w') or WORK_W))
            self.spp.setValue(int(bp.get('spp') or GATHER_SPP))
            self.moment_spp.setValue(int(bp.get('moment_spp') or MOMENT_SPP))
            self.ao_spp.setValue(int(bp.get('ao_spp') or AO_SPP))
            self.vol_spp.setValue(int(bp.get('vol_spp') or CHAR_VOL_SPP))
            self.vol_density.setValue(float(bp.get('vol_density') or 0.0))
            self.vol_max_cells.setValue(int(bp.get('vol_max_cells') or 0))
            self.nee_on.setChecked(bool(bp.get('nee', True)))
            self.clamp.setValue(float(bp.get('clamp_indirect') or 0.0))
            self.no_gi.setChecked(bool(bp.get('no_gi', False)))
            self.denoise_on.setChecked(bool(bp.get('denoise', True)))
            it = bp.get('denoise_iters')
            self.denoise_iters.setValue(ATROUS_ITERS if it is None else int(it))
            del blk2
        self.result = {'e': ctx.get('e'), 'e_ind': ctx.get('e_ind'),
                       'sun': ctx.get('sun', {'found': False}),
                       'gain': ctx.get('gain', 1.0), 'spec': spec,
                       'calibrated': True}
        self.status.setText('就绪。重估级旋钮即调即回帧;'
                            '重烘级旋钮改完点「重烘场景侧」。')
        self._refresh_cli()
        self._render()

    def _spec(self) -> dict:
        """在读入 spec 上**打补丁**,GUI 不认识的键原样保留(往返铁律)。"""
        spec = dict(self._sky_raw)
        spec['intensity'] = self.inten.value()
        if self.mode.currentText() == 'skybox':
            if self.sky_file.text() == '—':
                self.note.setText('skybox 模式但未选文件 —— 按 color 处理')
                spec['mode'] = 'color'
                spec['color'] = [self.r.value(), self.g.value(), self.b.value()]
                return spec
            spec['mode'] = 'skybox'
            spec['file'] = self.sky_file.text()
            return spec
        spec['mode'] = 'color'
        spec['color'] = [self.r.value(), self.g.value(), self.b.value()]
        return spec

    def _kick(self) -> None:
        if self.ctx is None or self.ctx.get('cache') is None:
            return
        if self.worker and self.worker.isRunning():
            self.debounce.start()                  # 正忙,稍后再试
            return
        iters = (self.denoise_iters.value()
                 if self.denoise_on.isChecked() else 0)
        self.worker = Recombine(self.ctx, self._spec(), iters, self._threads)
        self.worker.partial.connect(self._on_done)
        self.worker.done.connect(self._on_done)
        self._launch(self.worker)

    def _on_done(self, result: dict) -> None:
        if result.get('error'):
            self.status.setText(f'重估失败:{result["error"]}')
            return
        self.result = result
        if not result.get('calibrated', True):
            self.status.setText('重估中(E 先回帧,尺度未标定;太阳几秒后跟上)')
        else:
            self.status.setText('重估完成。')
        self._render()

    # ---------------- 渲染(全部只读 ctx 产物,零烘焙逻辑) ----------------
    def _placeholder(self, msg: str) -> np.ndarray:
        self.note.setText(msg)             # 不碰 status(审查 [25])
        return np.full((90, 160, 3), 0.18, np.float32)

    def _ensure_base(self):
        if self._base_cache is None:
            self._base_cache = preview_mod.base_of_ctx(self.ctx)
        return self._base_cache

    def _preset_sky(self):
        """→ (sky_def, sun_dir, 缺省 ev) | None(场景没配 sky)。"""
        pi = self.preset.currentIndex()
        if pi < len(preview_mod.TIME_PRESETS):
            _n, sky_def, sun_dir, ev = preview_mod.TIME_PRESETS[pi]
            return sky_def, sun_dir, ev
        try:
            sc = json.loads(self.ctx['inp'].scene_json.read_text(
                encoding='utf-8'))
            sky_def = (sc.get('lighting') or {}).get('sky')
        except Exception:                              # noqa: BLE001
            sky_def = None
        if not sky_def or not sky_def.get('intensity'):
            return None
        sun = self.ctx.get('sun') or {}
        sun_dir = sun.get('dir') if sun.get('found') else None
        return sky_def, sun_dir, 0.0

    def _vol_slice_img(self, kind: str) -> np.ndarray:
        vol = (self.ctx or {}).get('volume')
        if not vol:
            return self._placeholder('体数据未烘 —— 勾「含体积数据」后点'
                                     '「重烘场景侧」')
        g = vol['grid']
        nx, ny, nz = g['nx'], g['ny'], g['nz']
        iy = min(ny - 1, round(self.vol_slice.value() / 100 * (ny - 1)))
        raw = vol['raw']
        if kind == 'vol_sky':
            sl = raw['sky_a0'].reshape(nx, ny, nz)[:, iy, :].T * 2.0
            lo, hi = 0.0, 1.0
        elif kind == 'vol_ao':
            sl = raw['ao_a0'].reshape(nx, ny, nz)[:, iy, :].T
            lo, hi = 0.0, 1.0
        elif kind == 'vol_gi':
            full = np.log2(np.maximum(raw['gi_a0'] @ LUMA, 1e-4))
            if self._gi_slice_range is None:
                # 全体固定标度 —— 拖滑条切片间可比(审查 [22])
                self._gi_slice_range = (float(np.percentile(full, 1)),
                                        float(np.percentile(full, 99)) + 1e-6)
            lo, hi = self._gi_slice_range
            sl = full.reshape(nx, ny, nz)[:, iy, :].T
        else:
            sl = raw['invalid'].reshape(nx, ny, nz)[:, iy, :].T.astype(
                np.float32)
            lo, hi = 0.0, 1.0
        self.note.setText(f'y 层 {iy + 1}/{ny};residual_invalid='
                          f'{vol.get("residual_invalid", 0):.4f}')
        return _g2c(np.kron(sl, np.ones((4, 4))), lo, hi)

    def _channel_img(self) -> np.ndarray:
        ctx, res = self.ctx, self.result
        key = self.channel.currentData()
        self.note.setText('')
        a0f, a1f = ctx['moments_smooth']

        def missing(*keys):
            return [k for k in keys if ctx.get(k) is None]

        if key == 'final':
            if missing('e_q', 'inp'):
                return self._placeholder('该通道需要完整 ctx(重烘后可用)')
            ps = self._preset_sky()
            if ps is None:
                return self._placeholder('场景没配 lighting.sky(或 intensity=0)')
            sky_def, sun_dir, _ev = ps
            base, _bg = self._ensure_base()
            ck = self.preset.currentIndex()
            if ck not in self._sky_resp_cache:
                self._sky_resp_cache[ck] = preview_mod.sky_response(
                    a0f, a1f, ctx['normal'], sky_def, sun_dir)
            return preview_mod.compose_final(
                base, ctx['e_q'], self._sky_resp_cache[ck],
                gi=self.gi.value(), ev=self.ev.value())
        if key == 'painting':
            if missing('e_q', 'inp'):
                return self._placeholder('原画需要完整 ctx')
            return np.clip(self._ensure_base()[1], 0, 1)
        if key == 'recon':
            if missing('e_q', 'inp'):
                return self._placeholder('重构需要完整 ctx')
            base, _bg = self._ensure_base()
            zero = np.zeros_like(ctx['e_q'])
            return preview_mod.compose_final(base, ctx['e_q'], zero,
                                             gi=1.0, ev=0.0)
        if key == 'dehazed_hdr':
            return linear_to_srgb(from_hdr(ctx['hdr_work']))
        if key == 'e_lum':
            lum = res['e'] @ LUMA
            return _g2c(lum, 0, float(np.percentile(lum, 99)))
        if key == 'e_rgb':
            return linear_to_srgb(from_hdr(res['e']))
        if key == 'e_ind':
            e_ind = res.get('e_ind')
            if e_ind is None:
                return self._placeholder('E间接 需要重估一轮(动一下天空旋钮)')
            return linear_to_srgb(from_hdr(e_ind * res.get('gain', 1.0)))
        if key == 'e_dir':
            e_ind = res.get('e_ind')
            if e_ind is None or res.get('e') is None:
                return self._placeholder('E直接 需要重估一轮')
            # e 是 post-gain,e_ind 是 pre-gain —— 差前先统一尺度(审查 [1])
            d = np.maximum(
                (res['e'] - e_ind * res.get('gain', 1.0)) @ LUMA, 0)
            return _g2c(d, 0, max(float(np.percentile(d, 99)), 1e-6))
        if key == 'base_lum':
            if missing('e_q', 'inp'):
                return self._placeholder('base 需要完整 ctx')
            lum = np.log2(np.maximum(self._ensure_base()[0] @ LUMA, 1e-6))
            return _g2c(lum, float(np.percentile(lum, 1)),
                        float(np.percentile(lum, 99)))
        if key == 'base_chroma':
            if missing('e_q', 'inp'):
                return self._placeholder('base 需要完整 ctx')
            b = self._ensure_base()[0]
            return np.clip(b / np.maximum(b.max(-1, keepdims=True), 1e-6),
                           0, 1)
        if key == 'a0':
            return _g2c(a0f * 2.0)
        if key == 'vis_up':
            n = np.broadcast_to(np.array([0, 1, 0], np.float32),
                                a0f.shape + (3,))
            return _g2c(vis_of_normal(a0f, a1f, n))
        if key == 'bent':
            return np.clip(bent_of_moments(a1f, ctx['normal']) * 0.5 + 0.5,
                           0, 1)
        if key == 'a1':
            return np.clip(a1f + 0.5, 0, 1)
        if key == 'ao':
            return _g2c(ctx['ao'])
        if key == 'depth':
            if missing('inp'):
                return self._placeholder('深度需要完整 ctx')
            d = ctx['inp'].depth
            return _g2c(d, float(d.min()), float(d.max()))
        if key == 'normal':
            return np.clip(ctx['normal'] * 0.5 + 0.5, 0, 1)
        if key == 'dehazed':
            if ctx.get('lin_dehazed') is None:
                return self._placeholder('去霾图需要完整 ctx')
            return linear_to_srgb(ctx['lin_dehazed'])
        if key in ('vol_sky', 'vol_ao', 'vol_gi', 'vol_inv'):
            return self._vol_slice_img(key)
        return self._placeholder(f'未知通道 {key}')

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

    def resizeEvent(self, event) -> None:               # noqa: N802 — Qt 命名
        super().resizeEvent(event)
        self._render()                                  # 窗口变了图也要变(审查 [21])

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
        self._refresh_cli()
        self.debounce.start()

    def _save_bake_params(self) -> None:
        j = input_mod.save_bake_params(self.sid, self._bake_kwargs())
        QMessageBox.information(self, 'lightbake',
                                f'已存回 {j.name} 的 lighting.bakeParams。\n'
                                'CLI 不带旗标烘 = 自动用这份;带旗标 = 显式'
                                '覆盖(三级决议:显式 > 场景 > 库缺省)。')

    def _save_sky(self) -> None:
        j = input_mod.save_bake_sky(self.sid, self._spec())
        QMessageBox.information(self, 'lightbake',
                                f'已存回 {j.name} 的 lighting.bakeSky。\n'
                                'CLI 重烘读的就是这份 —— GUI 里看到什么,'
                                '无头重烘就出什么。')

    def _full_bake(self) -> None:
        if self.bake_worker and self.bake_worker.isRunning():
            self.status.setText('已有烘焙在跑,等它先(或点取消)。')
            return
        self.bake_btn.setEnabled(False)
        self.bake_btn.setText('烘焙中……')
        self.status.setText('全量 bake:\n' + self._cli_line_text())
        self._cancel_flag = False
        self.cancel_btn.setEnabled(True)
        spec = self._spec()
        kw = self._bake_kwargs()
        heavy = self.heavy_on.isChecked()
        threads = self._threads

        def job():
            set_threads(threads)
            return bake_scene(self.sid, sky_override=spec, quiet=False,
                              heavy_checks=heavy,
                              progress_cb=self._progress_cb, **kw)

        self.bake_worker = FnWorker(job)
        self.bake_worker.done.connect(self._on_full_bake_done)
        self._launch(self.bake_worker)

    def _on_full_bake_done(self, ctx: dict) -> None:
        self.bake_btn.setEnabled(True)
        self.bake_btn.setText('全量 bake(写载荷 + 自检 + report)')
        self.cancel_btn.setEnabled(False)
        if ctx.get('error'):
            self.status.setText(f'烘焙失败:{ctx["error"]}')
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        # 红也要看数据 + 开 report(CLI cmd_report 的既有口径,审查 [9])
        self.set_ctx(ctx)
        import webbrowser
        rp = ctx['out_dir'] / 'preview' / 'report.html'
        if rp.exists():
            webbrowser.open(rp.as_uri())
        if ctx.get('failed'):
            reds = [f"#{r.get('id')} {r.get('name', '')}"
                    for r in ctx.get('checks', [])
                    if r.get('status') == 'fail']
            QMessageBox.warning(
                self, 'lightbake',
                '自检有红,产物未落盘(report 已打开):\n' + '\n'.join(reds))

    def closeEvent(self, event) -> None:                # noqa: N802 — Qt 命名
        self._cancel_flag = True                        # 让烘焙尽快自己收
        for w_ in [self.worker, self.bake_worker] + list(self._retired):
            if w_ and w_.isRunning():
                if not w_.wait(8000):
                    self.status.setText('等待烘焙线程收尾……')
                    w_.wait()                           # 别销毁活线程
        event.accept()


def create_window(sid: str, autobake: bool = True,
                  threads: int = 0) -> tuple[QApplication, Win]:
    """出窗不进事件循环(离屏测试从这里进)。"""
    app = QApplication.instance() or QApplication(sys.argv)
    win = Win(sid, autobake=autobake, threads=threads)
    return app, win


def run_gui(sid: str, threads: int = 0) -> int:
    app, win = create_window(sid, autobake=True, threads=threads)
    win.resize(1280, 720)
    win.show()
    return app.exec()
