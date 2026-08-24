"""编辑器 GUI —— **壳,不是第二个烘焙器**(方案 §11.1)。

硬规矩:GUI 里每一个按钮背后都是 CLI 也能调到的同一个库函数,
GUI 自己不含一行烘焙逻辑。「GUI 里能做、CLI 做不到」= 架构 bug。

- 天空面板:纯色/skybox、颜色、强度 —— 边调边看;
- 实时性:§5.12 的 march 缓存重估(`combine_e`,常色天空亚秒),
  直射光反解(`solve_direct_light`)与合成(`compose_sun_e`)在工作线程,
  两段式回帧:E 秒回、太阳几秒后跟上;
- 首帧:`bake_scene(with_volume=False)` 在工作线程跑(视口不用体数据,
  也绝不冻 UI);「全量 bake」同样入线程,跑完开 report;
- 视口:E / base·E(原画重构)/ V / Bdir / AO 切换;
- 存回:`input.save_bake_sky`(内部走编辑器统一写盘出口 tools/editor/file_io);
  skybox 路径存**仓库相对路径**(绝对机器路径进 JSON 换台机器就废)。

report.html 仍是唯一的存档预览 —— 视口渲的是同一份数据(§5.12 重估逐位
等于真 bake),不存在两套渲染。
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
from PySide6.QtWidgets import (QApplication, QComboBox, QDoubleSpinBox,  # noqa: E402
                               QFileDialog, QFormLayout, QHBoxLayout, QLabel,
                               QMainWindow, QMessageBox, QPushButton,
                               QVBoxLayout, QWidget)

from tools.lightbake import input as input_mod                  # noqa: E402
from tools.lightbake.const import GATHER_SPP                    # noqa: E402
from tools.lightbake.denoise import denoise_e                   # noqa: E402
from tools.lightbake.encode import LUMA, from_hdr, linear_to_srgb  # noqa: E402
from tools.lightbake.gather import (bent_of_moments, combine_e,     # noqa: E402
                                    compose_sun_e, gather_gain_of,
                                    solve_direct_light, vis_of_normal)
from tools.lightbake.pipeline import bake_scene                 # noqa: E402
from tools.lightbake.sky import make_sky_sampler                # noqa: E402


class FnWorker(QThread):
    """把任意库函数调用丢进工作线程 —— GUI 自己零烘焙逻辑,连排队都不排。

    异常必须转成信号(复审纠正:线程里裸抛 ⇒ 界面永久停在「烘焙中」
    且零提示)。
    """

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
    """§5.12 下游后处理:天空半重组 → 直射光反解 → gain。无 march。

    两段式回报:E 重组(常色天空亚秒)先出一帧,直射光反解(数秒)算完
    再出最终帧 —— 「边调边看」看的是第一段。
    """

    partial = Signal(dict)
    done = Signal(dict)

    def __init__(self, ctx: dict, spec: dict):
        super().__init__()
        self.ctx, self.spec = ctx, spec

    def run(self) -> None:
        ctx = self.ctx
        inp = ctx['inp']
        sky_of = make_sky_sampler(self.spec, _ROOT)
        e_ind = combine_e(ctx['cache'], sky_of)
        # 与 pipeline 同一份 denoise_e(重估 ≡ 全新 bake 的构造性,§15)
        e_ind = denoise_e(e_ind, inp.normal, inp.depth)
        self.partial.emit({'e': e_ind, 'sun': {'found': False},
                           'gain': 1.0, 'spec': self.spec})
        a0f, a1f = ctx['moments_smooth']
        sun = solve_direct_light(inp.normal, a0f, a1f, ctx['hdr_work'],
                                 e_ind, progress=None)
        e = compose_sun_e(e_ind, inp.normal, a0f, a1f, sun)
        gain = gather_gain_of(ctx['hdr_work'], e)
        self.done.emit({'e': (e * gain).astype(np.float32),
                        'sun': sun, 'gain': gain, 'spec': self.spec})


class Win(QMainWindow):
    def __init__(self, sid: str, autobake: bool = True) -> None:
        super().__init__()
        self.sid = sid
        self.setWindowTitle(f'lightbake · {sid}')
        self.view = QLabel('烘焙中(首次需 march,不冻界面)……')
        self.view.setAlignment(Qt.AlignCenter)
        self.view.setMinimumSize(720, 405)

        self.channel = QComboBox()
        self.channel.addItems(['base·E(原画重构)', 'E(辐照度)',
                               'V(天穹可见度)', 'Bdir', 'AO'])
        self.mode = QComboBox()
        self.mode.addItems(['color', 'skybox'])
        self.r = self._spin(1.0)
        self.g = self._spin(1.0)
        self.b = self._spin(1.0)
        self.inten = self._spin(0.05, step=0.01)
        self.sky_file = QLabel('—')
        pick = QPushButton('选 skybox…')
        pick.clicked.connect(self._pick_file)

        save = QPushButton('存回场景 JSON(lighting.bakeSky)')
        save.clicked.connect(self._save_sky)
        self.bake_btn = QPushButton('全量 bake(写载荷 + report)')
        self.bake_btn.clicked.connect(self._full_bake)

        form = QFormLayout()
        form.addRow('视口通道', self.channel)
        form.addRow('天空模式', self.mode)
        form.addRow('R', self.r)
        form.addRow('G', self.g)
        form.addRow('B', self.b)
        form.addRow('强度', self.inten)
        form.addRow(pick, self.sky_file)
        side = QVBoxLayout()
        side.addLayout(form)
        side.addWidget(save)
        side.addWidget(self.bake_btn)
        side.addStretch(1)
        lay = QHBoxLayout()
        lay.addWidget(self.view, 1)
        box = QWidget()
        box.setLayout(side)
        box.setFixedWidth(280)
        lay.addWidget(box)
        root = QWidget()
        root.setLayout(lay)
        self.setCentralWidget(root)

        self.ctx: dict | None = None
        self.result: dict | None = None
        self.worker: Recombine | None = None
        self.bake_worker: FnWorker | None = None
        self.debounce = QTimer(self)
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(300)
        self.debounce.timeout.connect(self._kick)
        for w_ in (self.r, self.g, self.b, self.inten):
            w_.valueChanged.connect(self.debounce.start)
        self.mode.currentIndexChanged.connect(self.debounce.start)
        self.channel.currentIndexChanged.connect(self._render)
        if autobake:
            QTimer.singleShot(50, self._initial_bake)

    @staticmethod
    def _spin(v: float, step: float = 0.05) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(0.0, 100.0)
        s.setDecimals(3)
        s.setSingleStep(step)
        s.setValue(v)
        return s

    # ---------------- 数据流 ----------------
    def _initial_bake(self) -> None:
        # 首帧只出场景侧(视口不用体数据),在工作线程跑 —— 不冻 UI
        self.bake_worker = FnWorker(
            lambda: bake_scene(self.sid, spp=GATHER_SPP, with_volume=False,
                               quiet=True))
        self.bake_worker.done.connect(self.set_ctx)
        self.bake_worker.start()

    def set_ctx(self, ctx: dict) -> None:
        """接一份 pipeline ctx(离屏测试也从这里注入)。"""
        if ctx.get('error'):
            self.view.setText(f'烘焙失败:{ctx["error"]}')
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        self.ctx = ctx
        spec = ctx['sky_spec']
        self.mode.setCurrentText(spec.get('mode', 'color'))
        c = spec.get('color', [1, 1, 1])
        self.r.setValue(float(c[0]))
        self.g.setValue(float(c[1]))
        self.b.setValue(float(c[2]))
        self.inten.setValue(float(spec.get('intensity', 0.05)))
        if spec.get('file'):
            self.sky_file.setText(str(spec['file']))
        self.result = {'e': ctx['e'], 'sun': ctx['sun'],
                       'gain': ctx['gain'], 'spec': spec}
        self._render()

    def _spec(self) -> dict:
        if self.mode.currentText() == 'skybox' and self.sky_file.text() != '—':
            return {'mode': 'skybox', 'file': self.sky_file.text(),
                    'intensity': self.inten.value()}
        return {'mode': 'color',
                'color': [self.r.value(), self.g.value(), self.b.value()],
                'intensity': self.inten.value()}

    def _kick(self) -> None:
        if self.ctx is None or (self.worker and self.worker.isRunning()):
            self.debounce.start()                  # 正忙,稍后再试
            return
        self.worker = Recombine(self.ctx, self._spec())
        self.worker.partial.connect(self._on_done)
        self.worker.done.connect(self._on_done)
        self.worker.start()

    def _on_done(self, result: dict) -> None:
        self.result = result
        self._render()

    # ---------------- 渲染 ----------------
    def _render(self) -> None:
        if self.ctx is None or self.result is None:
            return
        ctx, res = self.ctx, self.result
        a0f, a1f = ctx['moments_smooth']
        ch = self.channel.currentIndex()
        if ch == 0:      # base·E ≡ from_hdr(hdr) = 去霾原画的重构
            img = linear_to_srgb(from_hdr(ctx['hdr_work']))
        elif ch == 1:
            lum = res['e'] @ LUMA
            img = np.repeat((np.clip(lum / max(float(np.percentile(lum, 99)),
                                               1e-6), 0, 1))[..., None], 3, -1)
        elif ch == 2:
            n = np.broadcast_to(np.array([0, 1, 0], np.float32), a0f.shape + (3,))
            img = np.repeat(vis_of_normal(a0f, a1f, n)[..., None], 3, -1)
        elif ch == 3:
            img = bent_of_moments(a1f, ctx['normal']) * 0.5 + 0.5
        else:
            img = np.repeat(ctx['ao'][..., None], 3, -1)
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
        # 存仓库相对路径:绝对机器路径写进场景 JSON,换台机器/CI 就废
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
        spec = self._spec()
        self.bake_worker = FnWorker(
            lambda: bake_scene(self.sid, sky_override=spec, quiet=False))
        self.bake_worker.done.connect(self._on_full_bake_done)
        self.bake_worker.start()

    def _on_full_bake_done(self, ctx: dict) -> None:
        self.bake_btn.setEnabled(True)
        self.bake_btn.setText('全量 bake(写载荷 + report)')
        if ctx.get('error'):
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        if ctx.get('failed'):
            QMessageBox.warning(self, 'lightbake',
                                '自检有红,产物未落盘;report 已生成,详见预览目录。')
            return
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
    win.resize(1100, 620)
    win.show()
    return app.exec()
