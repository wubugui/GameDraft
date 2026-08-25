"""编辑器 GUI —— **壳,不是第二个烘焙器**(方案 §11.1)。

硬规矩:GUI 里每一个旋钮背后都是 CLI 也能调到的同一个库函数/同一个参数,
GUI 自己不含一行烘焙逻辑,**连编排都不含**:§5.12 的重估序列走
`pipeline.recombine_sky`(唯一编排,自检 #12(c) 钉全链逐位);§6.1 预览走
`preview.sky_response/compose_final/ambient_env/volume_sky_at_surface`
(唯一实现)。面板常驻等价 CLI 命令行回显(含 `--sky`)。

工作流(2026-08-25 制作人 v4 需求):
- **场景浏览器**:自动扫描全部可烘场景,下拉即开;打开场景 = 用该场景
  `lighting.bakeParams` 的三级决议值烘首帧(不带上一个场景的面板残留),
  面板随 ctx 回填 —— 之后你调什么,「重烘/全量 bake」就烘什么,
  **一次只烘当前面板这一版参数**;
- 参数两档:重估级(bake 天空/去噪趟数,亚秒~秒回帧)与重烘级(点按钮);
- **运行时天空全参数实时可调**(intensity/profile/色温/地平线/辉光/地面/
  太阳方向;预设与「场景自身 lighting.sky」只是初始化器),E_环境(AO 消费)
  同组;三个存回按钮分别写 bakeSky / bakeParams / lighting.sky(运行时),
  全走编辑器统一写盘出口;
- 真进度条 + 取消;自检红照 CLI 口径开 report 列红项。

结构:`create_window(sid, autobake=False)` 出窗不进事件循环(离屏测试用),
`run_gui(sid, threads=0)` 是 CLI 入口。
"""
from __future__ import annotations

import json
import math
import sys
from functools import partial
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
                               QMessageBox, QProgressBar, QPushButton,
                               QScrollArea, QSlider, QSpinBox, QVBoxLayout,
                               QWidget)

from tools.lightbake import character as char_mod               # noqa: E402
from tools.lightbake import input as input_mod                  # noqa: E402
from tools.lightbake import lights as lights_mod                # noqa: E402
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
    编排一行不抄。两段式回帧:E 先出(partial,pre-gain、未标定尺度),
    太阳几秒后跟上(done)。异常照 FnWorker 规矩转信号。"""

    partial = Signal(dict)
    done = Signal(dict)

    def __init__(self, ctx: dict, spec: dict, denoise_iters: int,
                 threads: int, e_chroma_clamp: float | None = None,
                 demod_mode: str | None = None):
        super().__init__()
        self.ctx, self.spec = ctx, spec
        self.denoise_iters = denoise_iters
        self.threads = threads
        self.e_chroma_clamp = e_chroma_clamp
        self.demod_mode = demod_mode

    def run(self) -> None:
        try:
            set_threads(self.threads)                  # numba 线程数是线程局部的
            rec = recombine_sky(
                self.ctx, self.spec, denoise_iters=self.denoise_iters,
                demod_mode=self.demod_mode,
                e_chroma_clamp=self.e_chroma_clamp,
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


#: 视口通道:(稳定 key, 显示文案)。分发走 key,改文案不碎逻辑。
_CHANNELS = [
    ('final', '最终渲染预览(§6.1 镜像)'),
    ('final_vol', '最终渲染·体矩口径(角色受光一致性)'),
    ('painting', '原画(输入)'),
    ('recon', 'base·E_q(gi=1 无天光 ≡ 原画重构)'),
    ('dehazed_hdr', '去霾重构(hdr_work 显示)'),
    ('e_lum', 'E(最终,亮度)'),
    ('e_rgb', 'E(最终,彩色)'),
    ('e_ind', 'E间接'),
    ('e_dir', 'E直接(太阳反解)'),
    ('e_lights', 'E_灯+E_太阳(运行时解析灯)'),
    ('base_rgb', 'base(彩色,Reinhard 显示)'),
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


class _ViewLabel(QLabel):
    """视口:把按下/拖动/松开回报给宿主(探针球与立绘的自由移动用;
    Qt 在按住期间会持续派发 move,不需要 mouseTracking)。"""

    pressed = Signal(float, float)
    dragged = Signal(float, float)
    released = Signal()

    def mousePressEvent(self, ev) -> None:              # noqa: N802 — Qt 命名
        self.pressed.emit(float(ev.position().x()), float(ev.position().y()))
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev) -> None:               # noqa: N802 — Qt 命名
        self.dragged.emit(float(ev.position().x()), float(ev.position().y()))
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev) -> None:            # noqa: N802 — Qt 命名
        self.released.emit()
        super().mouseReleaseEvent(ev)


class Win(QMainWindow):
    progressed = Signal(str, int, int)

    def __init__(self, sid: str, autobake: bool = True,
                 threads: int = 0) -> None:
        super().__init__()
        self.sid = sid
        self._threads = int(threads)
        self.setWindowTitle(f'lightbake · {sid}')
        self.view = _ViewLabel('选场景后自动烘首帧(不冻界面)……')
        self.view.setAlignment(Qt.AlignCenter)
        self.view.setMinimumSize(720, 405)
        self.view.pressed.connect(self._on_view_click)
        self.view.dragged.connect(self._on_view_drag)
        self.view.released.connect(self._on_view_release)
        self.note = QLabel('')                # 通道级提示(占位原因等)
        self.note.setStyleSheet('color:#997; font-size: 11px;')
        self.status = QLabel('')
        self.status.setWordWrap(True)
        self.pbar = QProgressBar()
        self.pbar.setRange(0, 1)
        self.pbar.setValue(0)
        self.pbar.setFormat('空闲')

        # ---------------- 场景浏览器 ----------------
        self.scene_combo = QComboBox()
        for s in input_mod.list_bakeable():
            self.scene_combo.addItem(s)
        if self.scene_combo.findText(sid) >= 0:
            self.scene_combo.setCurrentText(sid)
        self.scene_combo.currentTextChanged.connect(self._on_scene_changed)

        # ---------------- 视口通道 ----------------
        self.channel = QComboBox()
        for key, label in _CHANNELS:
            self.channel.addItem(label, key)
        self.vol_slice = QSlider(Qt.Horizontal)
        self.vol_slice.setRange(0, 100)
        self.vol_slice.setValue(12)
        self.probe_on = QCheckBox('角色探针(点视口放置,实体口径吃 volume)')
        self.probe_occl = QCheckBox('§6.3 遮蔽口径(平盘 2·a₀,验收铁令)')

        # ---------------- 运行时天空(实时,§6.1 预览) ----------------
        self.preset = QComboBox()
        for p in preview_mod.TIME_PRESETS:
            self.preset.addItem(p[0])
        self.preset.addItem('场景自身 lighting.sky')
        self.rt_inten = self._dspin(1.2, step=0.05, hi=20.0)
        self.rt_profile = self._dspin(1.0, step=0.05, hi=1.0)
        self.rt_kelvin = self._dspin(10000, step=250, lo=1000, hi=20000)
        self.rt_hgain = self._dspin(0.0, step=0.1, hi=8.0)
        self.rt_hsharp = self._dspin(1.0, step=0.5, hi=16.0)
        self.rt_hkelvin = self._dspin(6500, step=250, lo=1000, hi=20000)
        self.rt_glgain = self._dspin(0.0, step=0.2, hi=16.0)
        self.rt_gltight = self._dspin(3.0, step=0.5, hi=16.0)
        self.rt_glkelvin = self._dspin(2100, step=100, lo=1000, hi=20000)
        self.rt_grgain = self._dspin(0.0, step=0.05, hi=4.0)
        self.rt_grkelvin = self._dspin(3000, step=250, lo=1000, hi=20000)
        self.sun_on = QCheckBox('太阳参与天空(辉光方向)')
        self.rt_sun_el = self._dspin(15.0, step=1.0, hi=90.0)
        self.rt_sun_az = self._dspin(45.0, step=5.0, hi=360.0)
        self.env_r = self._dspin(1.0, step=0.05, hi=4.0)
        self.env_g = self._dspin(1.0, step=0.05, hi=4.0)
        self.env_b = self._dspin(1.0, step=0.05, hi=4.0)
        self.env_gain = self._dspin(0.0, step=0.02, hi=4.0)
        self.gi = self._dspin(0.15, step=0.05, hi=1.0)
        self.ev = self._dspin(0.0, step=0.5, lo=-6.0, hi=8.0)
        save_rt = QPushButton('存回场景 JSON(lighting.sky 运行时天空)')
        save_rt.clicked.connect(self._save_runtime_sky)

        # ---------------- 灯光(运行时等价解析灯,§6.1 E_太阳+E_灯) ----------------
        self.lights_on = QCheckBox('E_灯 参与预览(场景 + 探针)')
        self.lights_on.setChecked(True)
        self.light_combo = QComboBox()
        self.light_kind_new = QComboBox()
        self.light_kind_new.addItems(list(lights_mod.LIGHT_KINDS))
        add_light = QPushButton('加灯')
        add_light.clicked.connect(self._add_light)
        del_light = QPushButton('删灯')
        del_light.clicked.connect(self._del_light)
        lrow = QHBoxLayout()
        for w_ in (self.light_kind_new, add_light, del_light):
            lrow.addWidget(w_)
        lrow_w = QWidget()
        lrow_w.setLayout(lrow)
        self.l_enabled = QCheckBox('enabled')
        self.l_kind = QComboBox()
        self.l_kind.addItems(list(lights_mod.LIGHT_KINDS))
        self.l_inten = self._dspin(2.5, step=0.1, hi=64.0)
        self.l_kelvin = self._dspin(2400, step=100, lo=1000, hi=40000)
        self.l_color_on = QCheckBox('显式 color(优先于 kelvin)')
        self.l_cr = self._dspin(1.0, step=0.05, hi=8.0)
        self.l_cg = self._dspin(1.0, step=0.05, hi=8.0)
        self.l_cb = self._dspin(1.0, step=0.05, hi=8.0)
        self.l_shadow = QCheckBox('castShadow(阴影,运行时同判据)')
        self.l_px = self._dspin(0.0, step=10.0, lo=-100000.0, hi=100000.0,
                                decimals=1)
        self.l_py = self._dspin(0.0, step=10.0, lo=-100000.0, hi=100000.0,
                                decimals=1)
        self.l_pz = self._dspin(0.0, step=10.0, lo=-100000.0, hi=100000.0,
                                decimals=1)
        self.l_range = self._dspin(450.0, step=10.0, lo=1.0, hi=20000.0,
                                   decimals=1)
        self.l_soft = self._dspin(10.0, step=1.0, hi=1000.0, decimals=1)
        # 方向向量不夹 [-1,1]:数据只要求方向、不要求归一,夹了会**转向**
        self.l_dx = self._dspin(0.0, step=0.05, lo=-100.0, hi=100.0)
        self.l_dy = self._dspin(-1.0, step=0.05, lo=-100.0, hi=100.0)
        self.l_dz = self._dspin(0.3, step=0.05, lo=-100.0, hi=100.0)
        self.l_inner = self._dspin(25.0, step=1.0, hi=89.0, decimals=1)
        self.l_outer = self._dspin(40.0, step=1.0, hi=90.0, decimals=1)
        self.l_sw = self._dspin(135.0, step=5.0, lo=1.0, hi=5000.0, decimals=1)
        self.l_sh = self._dspin(90.0, step=5.0, lo=1.0, hi=5000.0, decimals=1)
        self.l_roll = self._dspin(0.0, step=5.0, lo=-360.0, hi=360.0,
                                  decimals=1)
        self.l_two = QCheckBox('twoSided(双面发光)')
        self.l_el = self._dspin(45.0, step=1.0, lo=-90.0, hi=90.0, decimals=1)
        self.l_az = self._dspin(180.0, step=5.0, lo=-360.0, hi=360.0,
                                decimals=1)
        self.l_place = QCheckBox('点视口放置选中灯(表面点上方 75wu)')
        save_lt = QPushButton('存回场景 JSON(lighting.lights 运行时灯)')
        save_lt.clicked.connect(self._save_lights)

        # ---------------- 角色立绘(运行时角色管线镜像,character.py) ----------------
        self.char_on = QCheckBox('放角色立绘(点视口放脚点,吃体数据)')
        self.char_combo = QComboBox()
        for c in char_mod.list_characters():
            self.char_combo.addItem(c)
        if self.char_combo.findText('player_anim') >= 0:
            self.char_combo.setCurrentText('player_anim')
        self.c_mirror = QCheckBox('镜像(朝左)')
        self.c_flatten = self._dspin(0.0, step=0.05, hi=1.0)
        self.c_bulge = self._dspin(0.22, step=0.02, hi=2.0)
        self.c_aoc = self._dspin(0.0, step=0.05, hi=1.0)
        self.c_aof = self._dspin(0.0, step=0.05, hi=1.0)
        self.c_gi_follow = QCheckBox('charGi 跟随 gi(运行时缺省)')
        self.c_gi_follow.setChecked(True)
        self.c_gi = self._dspin(1.0, step=0.05, hi=4.0)
        self.c_ref = self._dspin(1.0, step=0.02, hi=8.0, decimals=4)

        # ---------------- 烘焙期天空组(重估级) ----------------
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
        self.demod_combo = QComboBox()
        self.demod_combo.addItem('色度钳制(缺省)', 'chroma_clamp')
        self.demod_combo.addItem('亮度解调', 'luminance')
        self.e_chroma = self._dspin(0.2, step=0.05, hi=4.0)   # 0 = 显式关钳

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

        group('场景', [('打开', self.scene_combo)])
        group('视口', [('通道', self.channel), ('体切片 y%', self.vol_slice),
                       (None, self.probe_on), (None, self.probe_occl)])
        group('运行时天空 + 环境(实时,§6.1 预览)', [
            ('预设(初始化器)', self.preset),
            ('intensity', self.rt_inten), ('profile', self.rt_profile),
            ('kelvin', self.rt_kelvin),
            ('horizonGain', self.rt_hgain), ('horizonSharp', self.rt_hsharp),
            ('horizonKelvin', self.rt_hkelvin),
            ('glowGain', self.rt_glgain), ('glowTight', self.rt_gltight),
            ('glowKelvin', self.rt_glkelvin),
            ('groundGain', self.rt_grgain), ('groundKelvin', self.rt_grkelvin),
            (None, self.sun_on),
            ('太阳仰角°', self.rt_sun_el), ('太阳方位°', self.rt_sun_az),
            ('环境色 R', self.env_r), ('环境色 G', self.env_g),
            ('环境色 B', self.env_b), ('环境强度(吃 AO)', self.env_gain),
            ('gi', self.gi), ('ev', self.ev),
            (None, save_rt)])
        group('灯光(运行时等价:平行/点/聚/面)', [
            (None, self.lights_on), ('灯', self.light_combo), (None, lrow_w),
            (None, self.l_enabled), ('kind', self.l_kind),
            ('intensity', self.l_inten), ('kelvin', self.l_kelvin),
            (None, self.l_color_on), ('color R', self.l_cr),
            ('color G', self.l_cg), ('color B', self.l_cb),
            (None, self.l_shadow),
            ('pos x(wu)', self.l_px), ('pos y(wu)', self.l_py),
            ('pos z(wu)', self.l_pz),
            ('range(wu)', self.l_range), ('softening 半径(wu)', self.l_soft),
            ('方向 x', self.l_dx), ('方向 y', self.l_dy),
            ('方向 z', self.l_dz),
            ('inner°', self.l_inner), ('outer°', self.l_outer),
            ('尺寸 宽(wu)', self.l_sw), ('尺寸 高(wu)', self.l_sh),
            ('roll°', self.l_roll), (None, self.l_two),
            ('仰角°', self.l_el), ('方位°', self.l_az),
            (None, self.l_place), (None, save_lt)])
        group('角色立绘(运行时角色管线:基底÷E_ref+体天穹/GI+灯march)', [
            (None, self.char_on), ('立绘', self.char_combo),
            (None, self.c_mirror),
            ('flatten', self.c_flatten), ('bulge', self.c_bulge),
            ('形体AO contact', self.c_aoc), ('形体AO form', self.c_aof),
            (None, self.c_gi_follow), ('charGi(不跟随时)', self.c_gi),
            ('charRefIntensity', self.c_ref)])
        group('烘焙期天空(重估级,喂 gather 的那份)', [
            ('模式', self.mode), ('R', self.r), ('G', self.g), ('B', self.b),
            ('强度', self.inten), (None, pick), (None, self.sky_file)])
        group('重建/色度(重估级)', [(None, self.denoise_on),
                                     ('去噪趟数', self.denoise_iters),
                                     ('base 解调', self.demod_combo),
                                     ('E 色度钳 τ(0=关钳)', self.e_chroma)])
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
        side.addStretch(1)

        panel = QWidget()
        panel.setLayout(side)
        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(340)
        # 进度条与状态**常驻视口下方**(不进右侧滚动面板 —— 实测会被
        # 四十行控件顶出可视区,等于没有;制作人抓的)
        self.pbar.setMinimumHeight(22)
        view_col = QVBoxLayout()
        view_col.addWidget(self.view, 1)
        view_col.addWidget(self.note)
        view_col.addWidget(self.pbar)
        view_col.addWidget(self.status)
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
        self._sky_cache: dict = {}
        self._lights: list = []
        self._light_idx: int = -1
        self._lights_cache: dict = {}     # (矩来源, 灯列表哈希) → (E_灯图, notes)
        self._lamp_vis: dict = {}         # 逐灯阴影图缓存(键含灯位/range/bias)
        self._lights_worker: FnWorker | None = None
        self._vol_m: tuple | None = None
        self._gi_slice_range: tuple | None = None
        self.progressed.connect(self._on_progress)
        self.debounce = QTimer(self)
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(300)
        self.debounce.timeout.connect(self._kick)
        self.sky_timer = QTimer(self)
        self.sky_timer.setSingleShot(True)
        self.sky_timer.setInterval(150)
        self.sky_timer.timeout.connect(self._rt_sky_dirty)
        self.lights_timer = QTimer(self)
        self.lights_timer.setSingleShot(True)
        self.lights_timer.setInterval(300)
        self.lights_timer.timeout.connect(self._lights_dirty)
        for w_ in (self.r, self.g, self.b, self.inten, self.denoise_iters,
                   self.e_chroma):
            w_.valueChanged.connect(self.debounce.start)
        self.mode.currentIndexChanged.connect(self.debounce.start)
        self.denoise_on.stateChanged.connect(self.debounce.start)
        self.demod_combo.currentIndexChanged.connect(self.debounce.start)
        self.demod_combo.currentIndexChanged.connect(self._refresh_cli)
        self.channel.currentIndexChanged.connect(self._render)
        self.preset.currentIndexChanged.connect(self._apply_preset)
        for w_ in (self.rt_inten, self.rt_profile, self.rt_kelvin,
                   self.rt_hgain, self.rt_hsharp, self.rt_hkelvin,
                   self.rt_glgain, self.rt_gltight, self.rt_glkelvin,
                   self.rt_grgain, self.rt_grkelvin,
                   self.rt_sun_el, self.rt_sun_az):
            w_.valueChanged.connect(self.sky_timer.start)
        self.sun_on.stateChanged.connect(self.sky_timer.start)
        for w_ in (self.gi, self.ev, self.env_r, self.env_g, self.env_b,
                   self.env_gain):
            w_.valueChanged.connect(self._render)
        self.vol_slice.valueChanged.connect(self._render)
        self.probe_on.stateChanged.connect(self._render)
        self.probe_occl.stateChanged.connect(self._render)
        self.lights_on.stateChanged.connect(self._render)
        self.char_on.stateChanged.connect(self._render)
        self.char_combo.currentTextChanged.connect(self._on_char_changed)
        self.c_mirror.stateChanged.connect(self._render)
        self.c_gi_follow.stateChanged.connect(self._render)
        for w_ in (self.c_flatten, self.c_bulge, self.c_aoc, self.c_aof,
                   self.c_gi, self.c_ref):
            w_.valueChanged.connect(self._render)
        self._char_foot: tuple | None = None
        self._char_sprite = None
        # 自由移动:按在球/角色身上直接拖(命中矩形每帧由 overlay 回填)
        self._drag_target: str | None = None     # 'probe' | 'char'
        self._drag_off: tuple = (0, 0)
        self._last_drag_t: float = 0.0
        self._probe_hit: tuple | None = None     # (cx, cy, r) 图像坐标
        self._char_hit: tuple | None = None      # (x0, y0, x1, y1)
        self.light_combo.currentIndexChanged.connect(self._on_light_selected)
        self.l_kind.currentIndexChanged.connect(self._on_light_retype)
        # 逐键回写(审查 P0-2/P1-9):只写被动过的语义组 —— 没动过的键在
        # dict 里保持原样,缺省不被物化、精度不被面板量程改写
        for key, ws in (('intensity', (self.l_inten,)),
                        ('kelvin', (self.l_kelvin,)),
                        ('color', (self.l_cr, self.l_cg, self.l_cb)),
                        ('pos', (self.l_px, self.l_py, self.l_pz)),
                        ('range', (self.l_range,)),
                        ('softeningRadius', (self.l_soft,)),
                        ('dirvec', (self.l_dx, self.l_dy, self.l_dz)),
                        ('innerAngleDeg', (self.l_inner,)),
                        ('outerAngleDeg', (self.l_outer,)),
                        ('size', (self.l_sw, self.l_sh)),
                        ('rollDeg', (self.l_roll,)),
                        ('elevationDeg', (self.l_el,)),
                        ('azimuthDeg', (self.l_az,))):
            for w_ in ws:
                w_.valueChanged.connect(partial(self._on_light_field, key))
        for key, w_ in (('enabled', self.l_enabled),
                        ('color', self.l_color_on),
                        ('castShadow', self.l_shadow),
                        ('twoSided', self.l_two)):
            w_.stateChanged.connect(partial(self._on_light_field, key))
        self._probe_px: tuple | None = None
        self._view_map: tuple | None = None   # (scale, offx, offy, w, h)
        for w_ in (self.spp, self.moment_spp, self.ao_spp, self.vol_spp,
                   self.vol_max_cells, self.denoise_iters, self.work_w):
            w_.valueChanged.connect(self._refresh_cli)
        for w_ in (self.vol_density, self.clamp, self.inten,
                   self.r, self.g, self.b, self.e_chroma):
            w_.valueChanged.connect(self._refresh_cli)
        for w_ in (self.nee_on, self.denoise_on, self.no_gi):
            w_.stateChanged.connect(self._refresh_cli)
        self.mode.currentIndexChanged.connect(self._refresh_cli)
        self._apply_preset(0)
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
        kw['demod_mode'] = self.demod_combo.currentData()
        kw['e_chroma_clamp'] = self.e_chroma.value()   # 0 = 显式关钳
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
        if kw['demod_mode'] != 'chroma_clamp':
            parts.append(f"--demod-mode {kw['demod_mode']}")
        if kw['e_chroma_clamp'] != 0.2:                # 库缺省 0.2
            parts.append(f"--e-chroma-clamp {kw['e_chroma_clamp']:g}")
        # 天空必须进等价行:GUI 的 bake 无条件带 sky_override(§11.1「肉眼可查」)
        parts.append("--sky '" + json.dumps(self._spec(), ensure_ascii=False,
                                            separators=(',', ':')) + "'")
        return ' '.join(parts)

    def _refresh_cli(self, *_a) -> None:
        self.cli_line.setText(self._cli_line_text())

    # ---------------- 运行时天空 ----------------
    def _runtime_sky_def(self) -> dict:
        return {'intensity': self.rt_inten.value(),
                'profile': self.rt_profile.value(),
                'kelvin': self.rt_kelvin.value(),
                'horizonGain': self.rt_hgain.value(),
                'horizonSharp': self.rt_hsharp.value(),
                'horizonKelvin': self.rt_hkelvin.value(),
                'glowGain': self.rt_glgain.value(),
                'glowTight': self.rt_gltight.value(),
                'glowKelvin': self.rt_glkelvin.value(),
                'groundGain': self.rt_grgain.value(),
                'groundKelvin': self.rt_grkelvin.value()}

    def _runtime_sun(self):
        if not self.sun_on.isChecked():
            return None
        el = math.radians(self.rt_sun_el.value())
        az = math.radians(self.rt_sun_az.value())
        return [math.cos(el) * math.sin(az), math.sin(el),
                math.cos(el) * math.cos(az)]

    def _apply_preset(self, idx: int) -> None:
        """预设/场景 sky = **初始化器**:把参数灌进旋钮,之后随便改。"""
        spins = (self.rt_inten, self.rt_profile, self.rt_kelvin,
                 self.rt_hgain, self.rt_hsharp, self.rt_hkelvin,
                 self.rt_glgain, self.rt_gltight, self.rt_glkelvin,
                 self.rt_grgain, self.rt_grkelvin, self.rt_sun_el,
                 self.rt_sun_az)
        if idx < len(preview_mod.TIME_PRESETS):
            _n, sky, sun, ev = preview_mod.TIME_PRESETS[idx]
        else:
            sky, sun, ev = None, None, 0.0
            try:
                sc = json.loads(self.ctx['inp'].scene_json.read_text(
                    encoding='utf-8'))
                sky = (sc.get('lighting') or {}).get('sky')
            except Exception:                          # noqa: BLE001
                pass
            if not sky:
                self.note.setText('场景没配 lighting.sky —— 保持当前旋钮值')
                return
            s = self.ctx.get('sun') if self.ctx else None
            sun = s.get('dir') if (s and s.get('found')) else None
        blk = [QSignalBlocker(w) for w in spins + (self.sun_on, self.ev)]
        self.rt_inten.setValue(float(sky.get('intensity', 1.0)))
        self.rt_profile.setValue(float(sky.get('profile', 1.0)))
        self.rt_kelvin.setValue(float(sky.get('kelvin', 6500)))
        self.rt_hgain.setValue(float(sky.get('horizonGain', 0.0)))
        self.rt_hsharp.setValue(float(sky.get('horizonSharp', 1.0)))
        self.rt_hkelvin.setValue(float(sky.get('horizonKelvin', 6500)))
        self.rt_glgain.setValue(float(sky.get('glowGain', 0.0)))
        self.rt_gltight.setValue(float(sky.get('glowTight', 3.0)))
        self.rt_glkelvin.setValue(float(sky.get('glowKelvin', 2100)))
        self.rt_grgain.setValue(float(sky.get('groundGain', 0.0)))
        self.rt_grkelvin.setValue(float(sky.get('groundKelvin', 3000)))
        if sun is not None:
            self.sun_on.setChecked(True)
            self.rt_sun_el.setValue(math.degrees(math.asin(
                max(-1.0, min(1.0, float(sun[1]))))))
            self.rt_sun_az.setValue(math.degrees(
                math.atan2(float(sun[0]), float(sun[2]))) % 360.0)
        else:
            self.sun_on.setChecked(False)
        self.ev.setValue(float(ev))
        del blk
        self._rt_sky_dirty()

    def _rt_sky_dirty(self) -> None:
        self._sky_cache.clear()
        self._render()

    def _sky_cached(self, kind: str, a0f, a1f, normal) -> np.ndarray:
        sky = self._runtime_sky_def()
        sun = self._runtime_sun()
        key = (kind, json.dumps(sky, sort_keys=True),
               None if sun is None else tuple(round(v, 5) for v in sun))
        if key not in self._sky_cache:
            self._sky_cache[key] = preview_mod.sky_response(
                a0f, a1f, normal, sky, sun)
        return self._sky_cache[key]

    def _env_term(self):
        if self.env_gain.value() <= 0 or self.ctx is None \
                or self.ctx.get('ao') is None:
            return None
        return preview_mod.ambient_env(
            self.ctx['ao'],
            [self.env_r.value(), self.env_g.value(), self.env_b.value()],
            self.env_gain.value())

    def _save_runtime_sky(self) -> None:
        j = input_mod.save_runtime_sky(self.sid, self._runtime_sky_def())
        QMessageBox.information(self, 'lightbake',
                                f'已存回 {j.name} 的 lighting.sky(运行时'
                                '着色消费的那份;bakeSky 是另一份)。')

    # ---------------- 灯光编辑(壳:数据是 lighting.lights,算法在 lights.py) ----------------
    def _light_sel(self) -> dict | None:
        i = self.light_combo.currentIndex()
        if 0 <= i < len(self._lights):
            self._light_idx = i
            return self._lights[i]
        return None

    def _rebuild_light_combo(self, keep: int = -1) -> None:
        with QSignalBlocker(self.light_combo):
            self.light_combo.clear()
            for l in self._lights:
                self.light_combo.addItem(
                    f"{l.get('id', '?')} · {l.get('kind', '?')}")
            if self._lights:
                self.light_combo.setCurrentIndex(
                    keep if 0 <= keep < len(self._lights)
                    else len(self._lights) - 1)
        self._load_light_fields()

    def _on_light_selected(self, _i: int) -> None:
        self._load_light_fields()

    def _load_light_fields(self) -> None:
        l = self._light_sel()
        kind = (l or {}).get('kind', 'point')
        ed = l is not None
        en = {'pos': ed and kind != 'directional',
              'range': ed and kind != 'directional',
              'soft': ed and kind in ('point', 'spot'),
              'dir': ed and kind in ('spot', 'area'),
              'cone': ed and kind == 'spot',
              'size': ed and kind == 'area',
              'ang': ed and kind == 'directional'}
        for w_ in (self.l_enabled, self.l_kind, self.l_inten, self.l_kelvin,
                   self.l_color_on, self.l_cr, self.l_cg, self.l_cb,
                   self.l_shadow):
            w_.setEnabled(ed)
        for w_, k in ((self.l_px, 'pos'), (self.l_py, 'pos'),
                      (self.l_pz, 'pos'), (self.l_range, 'range'),
                      (self.l_soft, 'soft'), (self.l_dx, 'dir'),
                      (self.l_dy, 'dir'), (self.l_dz, 'dir'),
                      (self.l_inner, 'cone'), (self.l_outer, 'cone'),
                      (self.l_sw, 'size'), (self.l_sh, 'size'),
                      (self.l_roll, 'size'), (self.l_two, 'size'),
                      (self.l_el, 'ang'), (self.l_az, 'ang')):
            w_.setEnabled(en[k])
        if not ed:
            return
        blk = [QSignalBlocker(w) for w in
               (self.l_enabled, self.l_kind, self.l_inten, self.l_kelvin,
                self.l_color_on, self.l_cr, self.l_cg, self.l_cb,
                self.l_shadow, self.l_px, self.l_py, self.l_pz, self.l_range,
                self.l_soft, self.l_dx, self.l_dy, self.l_dz, self.l_inner,
                self.l_outer, self.l_sw, self.l_sh, self.l_roll, self.l_two,
                self.l_el, self.l_az)]
        self.l_enabled.setChecked(bool(l.get('enabled', True)))
        self.l_kind.setCurrentText(
            kind if kind in lights_mod.LIGHT_KINDS else 'point')
        self.l_inten.setValue(float(l.get('intensity', 0.0)))
        self.l_kelvin.setValue(float(l.get('kelvin', 6500.0)))
        c = l.get('color')
        self.l_color_on.setChecked(c is not None)
        if c is not None:
            self.l_cr.setValue(float(c[0]))
            self.l_cg.setValue(float(c[1]))
            self.l_cb.setValue(float(c[2]))
        else:
            # 复位:否则切到无 color 的灯再勾「显式 color」,写进去的是
            # **上一盏灯**的颜色(复核顺带项)
            self.l_cr.setValue(1.0)
            self.l_cg.setValue(1.0)
            self.l_cb.setValue(1.0)
        # castShadow 的显示缺省与求值同一条决议(审查 P0-2):太阳(第一盏
        # enabled directional)缺省 **true**(packLights `?? true` ⇒ 0.9),
        # 其余缺省 false —— 显示口径与求值口径分家会让"动一下强度"变成
        # "静默关掉太阳阴影并存盘"
        is_sun = l is lights_mod.sun_light_of(self._lights)
        self.l_shadow.setChecked(bool(l.get('castShadow', is_sun)))
        p = l.get('pos') or [0.0, 0.0, 0.0]
        self.l_px.setValue(float(p[0]))
        self.l_py.setValue(float(p[1]))
        self.l_pz.setValue(float(p[2]))
        self.l_range.setValue(float(l.get('range', 450.0)))
        self.l_soft.setValue(float(l.get('softeningRadius', 10.0)))
        d = l.get('dir') or l.get('orientation') or [0.0, 0.0, -1.0]
        self.l_dx.setValue(float(d[0]))
        self.l_dy.setValue(float(d[1]))
        self.l_dz.setValue(float(d[2]))
        self.l_inner.setValue(float(l.get('innerAngleDeg', 25.0)))
        self.l_outer.setValue(float(l.get('outerAngleDeg', 40.0)))
        s = l.get('size') or [135.0, 90.0]
        self.l_sw.setValue(float(s[0]))
        self.l_sh.setValue(float(s[1]))
        self.l_roll.setValue(float(l.get('rollDeg', 0.0)))
        self.l_two.setChecked(bool(l.get('twoSided', False)))
        self.l_el.setValue(float(l.get('elevationDeg', 45.0)))
        self.l_az.setValue(float(l.get('azimuthDeg', 180.0)))
        del blk

    def _on_light_field(self, key: str, *_a) -> None:
        """**逐键**回写(审查 P0-2/P1-9):只写触发信号的那个语义组,且组
        不适用当前 kind 时不落键 —— 装载→不动→存回 必须逐键恒等。"""
        l = self._light_sel()
        if l is None:
            return
        kind = l.get('kind', 'point')
        if key == 'enabled':
            l['enabled'] = self.l_enabled.isChecked()
            # 「谁是太阳」可能因此改变 ⇒ castShadow 的显示缺省要跟着求值
            # 口径刷新(复核:is_sun 只在装载时求一次的残余分家)
            self._load_light_fields()
        elif key == 'intensity':
            l['intensity'] = self.l_inten.value()
        elif key == 'kelvin':
            l['kelvin'] = self.l_kelvin.value()
        elif key == 'castShadow':
            l['castShadow'] = self.l_shadow.isChecked()
        elif key == 'color':
            if self.l_color_on.isChecked():
                l['color'] = [self.l_cr.value(), self.l_cg.value(),
                              self.l_cb.value()]
            else:
                l.pop('color', None)
        elif key == 'pos' and kind != 'directional':
            l['pos'] = [self.l_px.value(), self.l_py.value(),
                        self.l_pz.value()]
        elif key == 'range' and kind != 'directional':
            l['range'] = self.l_range.value()
        elif key == 'softeningRadius' and kind in ('point', 'spot'):
            l['softeningRadius'] = self.l_soft.value()
        elif key == 'dirvec' and kind in ('spot', 'area'):
            vec = [self.l_dx.value(), self.l_dy.value(), self.l_dz.value()]
            if kind == 'spot':
                l['dir'] = vec
                l.pop('orientation', None)
            else:
                # 打包取值序是 dir??orientation(P0-1)—— 面光编辑写
                # orientation 时必须清掉 dir,否则预览与游戏各看一面
                l['orientation'] = vec
                l.pop('dir', None)
        elif key == 'innerAngleDeg' and kind == 'spot':
            v = self.l_inner.value()
            l['innerAngleDeg'] = v
            if v > self.l_outer.value():        # 0<inner≤outer(编辑器同校验)
                with QSignalBlocker(self.l_outer):
                    self.l_outer.setValue(v)
                l['outerAngleDeg'] = v
        elif key == 'outerAngleDeg' and kind == 'spot':
            v = self.l_outer.value()
            l['outerAngleDeg'] = v
            if v < self.l_inner.value():
                with QSignalBlocker(self.l_inner):
                    self.l_inner.setValue(v)
                l['innerAngleDeg'] = v
        elif key == 'size' and kind == 'area':
            l['size'] = [self.l_sw.value(), self.l_sh.value()]
        elif key == 'rollDeg' and kind == 'area':
            l['rollDeg'] = self.l_roll.value()
        elif key == 'twoSided' and kind == 'area':
            l['twoSided'] = self.l_two.isChecked()
        elif key == 'elevationDeg' and kind == 'directional':
            l['elevationDeg'] = self.l_el.value()
        elif key == 'azimuthDeg' and kind == 'directional':
            l['azimuthDeg'] = self.l_az.value()
        else:
            return                              # 组不适用当前 kind ⇒ 不落键
        self._lights_cache.clear()
        self.lights_timer.start()

    def _on_light_retype(self, _i: int) -> None:
        l = self._light_sel()
        if l is None:
            return
        kind = self.l_kind.currentText()
        if kind == l.get('kind'):
            return
        self._lights[self._light_idx] = lights_mod.retype_light(l, kind)
        self._rebuild_light_combo(self._light_idx)
        self._lights_dirty()

    def _add_light(self) -> None:
        used = {l.get('id') for l in self._lights}
        n = 1
        while f'light_{n}' in used:             # 唯一 id(审查 P1-8)
            n += 1
        self._lights.append(lights_mod.default_light(
            n, self.light_kind_new.currentText()))
        self._rebuild_light_combo(len(self._lights) - 1)
        self._lights_dirty()

    def _del_light(self) -> None:
        i = self.light_combo.currentIndex()
        if 0 <= i < len(self._lights):
            self._lights.pop(i)
            self._rebuild_light_combo(min(i, len(self._lights) - 1))
            self._lights_dirty()

    def _lights_dirty(self) -> None:
        self._lights_cache.clear()
        self._render()

    def _lights_term(self, kind_key: str, a0u, a1u):
        """当前灯列表在给定遮蔽口径上的 E_太阳+E_灯(lights.py 唯一实现)。
        逐灯阴影 march 在**后台线程**(审查 P0-3:同步跑会冻 GUI 数秒),
        没算完返回 None(通道先出无灯帧/占位),算完自动重渲。缓存键按矩
        **来源**分桶('px'/'vol',审查 P2-14:final 与 e_lights 同源同价)。"""
        if (not self.lights_on.isChecked() or not self._lights
                or self.ctx is None or self.ctx.get('inp') is None
                or float(getattr(self.ctx['inp'], 'scene_per_wu', 0) or 0) <= 0):
            return None
        src = 'vol' if kind_key == 'final_vol' else 'px'
        key = (src, json.dumps(self._lights, sort_keys=True, default=float))
        hit = self._lights_cache.get(key)
        if hit is not None:
            if hit[1]:
                self.note.setText(';'.join(hit[1]))
            return hit[0]
        if self._lights_worker and self._lights_worker.isRunning():
            self.note.setText('E_灯 计算中(逐灯阴影 march,后台)……')
            return None
        ctx, lamp_vis = self.ctx, self._lamp_vis
        lights_snap = [dict(l) for l in self._lights]

        def job():
            notes: list = []
            arr = lights_mod.eval_scene_lights(
                lights_snap, ctx['inp'], a0u, a1u, ctx['normal'],
                vis_cache=lamp_vis, notes=notes)
            return {'key': key, 'e': arr, 'notes': notes, 'ctx': ctx}

        self._lights_worker = FnWorker(job)
        self._lights_worker.done.connect(self._on_lights_done)
        self._launch(self._lights_worker)
        self.note.setText('E_灯 计算中(逐灯阴影 march,后台)……')
        return None

    def _on_lights_done(self, res: dict) -> None:
        if res.get('error'):
            self.note.setText(f'E_灯 计算失败:{res["error"]}')
            return
        if res.get('ctx') is not self.ctx:
            # 复核红(2026-08-26):重烘落地(set_ctx)时在飞 worker 端上来的
            # 是**旧 ctx** 的 E_灯 —— 缓存键不含 ctx 身份,写进去会被下一帧
            # 原样端出。陈旧结果整体丢弃;_render→_lights_term 会用新 ctx
            # 重新起一枪(set_ctx 已把 _lamp_vis 换成新对象,旧图进不来)。
            self._render()
            return
        self._lights_cache[res['key']] = (res['e'], res['notes'])
        self._render()

    def _save_lights(self) -> None:
        # 与桌面编辑器同一套校验(审查 P1-8:写同一个权威文件就得过同一道门)
        from tools.editor.editors.scene_lights import validate_lights
        issues = validate_lights(self._lights)
        if issues:
            ret = QMessageBox.warning(
                self, 'lightbake',
                '灯数据没过 validate_lights(桌面编辑器同一套校验):\n'
                + '\n'.join(issues[:12])
                + ('\n…' if len(issues) > 12 else '')
                + '\n\n仍要存回吗?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
            if ret != QMessageBox.Yes:
                return
        j = input_mod.save_lights(self.sid, self._lights)
        QMessageBox.information(self, 'lightbake',
                                f'已存回 {j.name} 的 lighting.lights(运行时'
                                '消费的解析灯;与桌面编辑器 scene_lights 同'
                                '一份数据)。')

    # ---------------- 数据流 ----------------
    def _initial_bake(self) -> None:
        self._start_bake(use_panel=False, with_volume=False,
                         label=f'打开场景 {self.sid}(按场景 bakeParams 决议'
                               '烘首帧)……')

    def _on_scene_changed(self, sid: str) -> None:
        if not sid or sid == self.sid:
            return
        if (self.bake_worker and self.bake_worker.isRunning()) or \
                (self.worker and self.worker.isRunning()) or \
                (self._lights_worker and self._lights_worker.isRunning()):
            with QSignalBlocker(self.scene_combo):
                self.scene_combo.setCurrentText(self.sid)
            self.status.setText('烘焙/灯计算进行中,先取消/等完成再换场景。')
            return
        self.sid = sid
        self.setWindowTitle(f'lightbake · {sid}')
        self.ctx = None
        self.result = None
        self._base_cache = None
        self._sky_cache.clear()
        self._lights = []
        self._lights_cache = {}
        self._lamp_vis = {}
        self._vol_m = None
        self._gi_slice_range = None
        self.view.setText(f'打开 {sid},烘首帧……')
        self._refresh_cli()
        self._start_bake(use_panel=False, with_volume=False,
                         label=f'打开场景 {sid}……')

    def _preview_rebake(self) -> None:
        self._start_bake(use_panel=True,
                         with_volume=self.with_volume.isChecked(),
                         label='重烘场景侧(预览,当前面板这一版参数)……')

    def _progress_cb(self, stage: str, i: int, n: int) -> None:
        """跑在工作线程里:发进度信号 + 响应取消。"""
        if self._cancel_flag:
            raise _Cancelled('用户取消')
        if i == n or i % max(1, n // 16) == 0:
            self.progressed.emit(stage, i, n)

    def _on_progress(self, stage: str, i: int, n: int) -> None:
        self.pbar.setRange(0, n)
        self.pbar.setValue(i)
        self.pbar.setFormat(f'{stage}  %v/%m')

    def _launch(self, worker: QThread) -> None:
        self._retired.append(worker)
        worker.finished.connect(
            lambda w=worker: self._retired.remove(w)
            if w in self._retired else None)
        worker.start()

    def _start_bake(self, use_panel: bool, with_volume: bool,
                    label: str) -> None:
        if self.bake_worker and self.bake_worker.isRunning():
            self.status.setText('已有烘焙在跑,等它先(或点取消)。')
            return
        self.status.setText(label)
        self._cancel_flag = False
        self.cancel_btn.setEnabled(True)
        # 一次只烘一版参数:打开场景 = 场景 JSON 三级决议;重烘 = 面板快照
        kw = self._bake_kwargs() if use_panel else {}
        sky_override = self._spec() if (use_panel and self.ctx) else None
        sid = self.sid
        threads = self._threads

        def job():
            set_threads(threads)          # numba 线程数是线程局部的
            return bake_scene(sid, with_volume=with_volume,
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
        self.pbar.setRange(0, 1)
        self.pbar.setValue(0)
        self.pbar.setFormat('空闲')
        if ctx.get('error'):
            self.status.setText(f'烘焙失败:{ctx["error"]}')
            QMessageBox.critical(self, 'lightbake', f'烘焙失败:{ctx["error"]}')
            return
        self.ctx = ctx
        self._base_cache = None
        self._sky_cache.clear()
        # 换**新对象**而不是 clear:在飞的灯 worker 闭包持有旧 dict,
        # 只会继续写旧的 —— 旧 ctx 的阴影图永远进不了新一轮缓存(复核红)
        self._lights_cache = {}
        self._lamp_vis = {}
        # 灯列表 = 场景 JSON lighting.lights 的可编辑副本(装载走 input.load)
        self._lights = [dict(l) for l in
                        (getattr(ctx.get('inp'), 'lights', None) or [])]
        self._rebuild_light_combo(0)
        # charRefIntensity/charGi 回填场景值(运行时角色链的两个作者参数)
        try:
            sc = json.loads(ctx['inp'].scene_json.read_text(encoding='utf-8'))
            lt = sc.get('lighting') or {}
            with QSignalBlocker(self.c_ref):
                self.c_ref.setValue(float(lt.get('charRefIntensity') or 1.0))
            cg = lt.get('charGi')
            with QSignalBlocker(self.c_gi_follow), QSignalBlocker(self.c_gi):
                self.c_gi_follow.setChecked(cg is None)
                if cg is not None:
                    self.c_gi.setValue(float(cg))
        except Exception:                           # noqa: BLE001 — 假 ctx 降级
            pass
        self._char_foot = None
        self._vol_m = None
        self._gi_slice_range = None
        spec = dict(ctx.get('sky_spec') or {})
        spec.pop('_source', None)
        self._sky_raw = spec              # 往返保真的底稿
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
        # 质量面板回填为**决议后**的值(场景 bakeParams 如实可见)
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
            self.e_chroma.setValue(float(bp.get('e_chroma_clamp')
                                         if bp.get('e_chroma_clamp')
                                         is not None else 0.2))
            with QSignalBlocker(self.demod_combo):
                di = self.demod_combo.findData(
                    bp.get('demod_mode') or 'chroma_clamp')
                self.demod_combo.setCurrentIndex(max(di, 0))
            del blk2
        self.result = {'e': ctx.get('e'), 'e_ind': ctx.get('e_ind'),
                       'sun': ctx.get('sun', {'found': False}),
                       'gain': ctx.get('gain', 1.0), 'spec': spec,
                       'calibrated': True}
        self.status.setText('就绪。运行时天空/环境即调即渲;bake 天空与去噪'
                            '即调即重估;重烘级改完点按钮。')
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
        self.worker = Recombine(self.ctx, self._spec(), iters, self._threads,
                                self.e_chroma.value(),
                                self.demod_combo.currentData())
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
        self.note.setText(msg)
        return np.full((90, 160, 3), 0.18, np.float32)

    def _ensure_base(self):
        if self._base_cache is None:
            self._base_cache = preview_mod.base_of_ctx(self.ctx)
        return self._base_cache

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

        if key in ('final', 'final_vol'):
            if missing('e_q', 'inp'):
                return self._placeholder('该通道需要完整 ctx(重烘后可用)')
            base, _bg = self._ensure_base()
            if key == 'final_vol':
                if not ctx.get('volume'):
                    return self._placeholder('需要体数据 —— 勾「含体积」重烘')
                if self._vol_m is None:
                    self._vol_m = preview_mod.volume_sky_at_surface(ctx)
                a0u, a1u = self._vol_m
            else:
                a0u, a1u = a0f, a1f
            e_sky = self._sky_cached(key, a0u, a1u, ctx['normal'])
            return preview_mod.compose_final(
                base, ctx['e_q'], e_sky, gi=self.gi.value(),
                ev=self.ev.value(), e_env=self._env_term(),
                e_lights=self._lights_term(key, a0u, a1u))
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
            d = np.maximum(
                (res['e'] - e_ind * res.get('gain', 1.0)) @ LUMA, 0)
            return _g2c(d, 0, max(float(np.percentile(d, 99)), 1e-6))
        if key == 'e_lights':
            if missing('inp', 'normal'):
                return self._placeholder('E_灯 需要完整 ctx')
            el = self._lights_term('e_lights', a0f, a1f)
            if el is None:
                if self._lights_worker and self._lights_worker.isRunning():
                    return self._placeholder('E_灯 后台计算中(算完自动刷新)……')
                return self._placeholder('无灯/未启用 —— 灯光组勾选 + 加灯'
                                         '(或场景 lighting.lights)')
            return linear_to_srgb(from_hdr(el))
        if key == 'base_rgb':
            if missing('e_q', 'inp'):
                return self._placeholder('base 需要完整 ctx')
            return linear_to_srgb(from_hdr(self._ensure_base()[0]))
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

    def _on_char_changed(self, _t: str) -> None:
        self._char_sprite = None
        self._render()

    def _overlay_char(self, img: np.ndarray) -> np.ndarray:
        """把立绘按运行时角色管线着色后合成进视口(character.py 唯一实现,
        壳零算法)。需要体数据(角色吃 char_volume,§6.1 实体口径)。"""
        key = self.channel.currentData()
        if (not self.char_on.isChecked() or self._char_foot is None
                or key not in ('final', 'final_vol')
                or not (self.ctx or {}).get('volume')
                or self.ctx.get('inp') is None
                or float(getattr(self.ctx['inp'], 'scene_per_wu', 0) or 0) <= 0
                or not self.char_combo.currentText()):
            return img
        inp = self.ctx['inp']
        h, w = img.shape[:2]
        ix, iy = self._char_foot
        ix = int(np.clip(ix, 0, w - 1))
        iy = int(np.clip(iy, 0, h - 1))
        try:
            if self._char_sprite is None:
                self._char_sprite = char_mod.load_character(
                    self.char_combo.currentText())
            crgb, ca = char_mod.shade_character(
                self.ctx, self._char_sprite,
                inp.world[iy, ix].astype(np.float64),
                self._runtime_sky_def(), self._runtime_sun(),
                gi=self.gi.value(), ev=self.ev.value(),
                env_rgb=[self.env_r.value(), self.env_g.value(),
                         self.env_b.value()],
                env_gain=self.env_gain.value(),
                lights=(self._lights if self.lights_on.isChecked() else []),
                char_gi=(None if self.c_gi_follow.isChecked()
                         else self.c_gi.value()),
                char_ref_intensity=self.c_ref.value(),
                flatten=self.c_flatten.value(), bulge=self.c_bulge.value(),
                ao_contact=self.c_aoc.value(), ao_form=self.c_aof.value(),
                mirror=self.c_mirror.isChecked())
        except Exception as exc:                    # noqa: BLE001 — 显示不许炸
            self.note.setText(f'立绘着色失败:{type(exc).__name__}: {exc}')
            return img
        ch, cw = crgb.shape[:2]
        y1, x0 = iy, ix - cw // 2                   # 脚点 = 底边中点
        y0 = y1 - ch
        sy0, sx0 = max(0, -y0), max(0, -x0)
        y0, x0 = max(0, y0), max(0, x0)
        y2, x2 = min(h, y1), min(w, x0 + (cw - sx0))
        if y2 <= y0 or x2 <= x0:
            return img
        out = img.copy()
        a = ca[sy0:sy0 + (y2 - y0), sx0:sx0 + (x2 - x0), None]
        out[y0:y2, x0:x2] = (out[y0:y2, x0:x2] * (1 - a)
                             + crgb[sy0:sy0 + (y2 - y0),
                                    sx0:sx0 + (x2 - x0)] * a)
        self._char_hit = (x0, y0, x2, y2)         # 抓取命中区(自由移动)
        return out

    def _overlay_probe(self, img: np.ndarray) -> np.ndarray:
        """把角色探针球合成进视口图(实体口径吃 volume;§6.1/§6.3 镜像)。"""
        key = self.channel.currentData()
        if (not self.probe_on.isChecked() or self._probe_px is None
                or key not in ('final', 'final_vol', 'a0')
                or not (self.ctx or {}).get('volume')
                or self.ctx.get('inp') is None):
            return img
        inp = self.ctx['inp']
        h, w = img.shape[:2]
        ix, iy = self._probe_px
        ix = int(np.clip(ix, 0, w - 1))
        iy = int(np.clip(iy, 0, h - 1))
        ground = inp.world[iy, ix].astype(np.float64)
        center = ground + np.array([0.0, inp.char_wu / 2.0, 0.0])
        sample = preview_mod.sample_volume_probe(self.ctx, center)
        radius_px = max(4, int(round(inp.char_wu / 2.0 * inp.ppu)))
        occl = self.probe_occl.isChecked() or key == 'a0'
        def _probe_lights_cb(N, _c=center):
            return lights_mod.eval_probe_lights(self._lights, N, _c, inp)
        lights_cb = (_probe_lights_cb
                     if (self.lights_on.isChecked() and self._lights
                         and float(getattr(inp, 'scene_per_wu', 0) or 0) > 0)
                     else None)
        rgb, alpha = preview_mod.shade_probe_ball(
            sample, inp.R, self._runtime_sky_def(), self._runtime_sun(),
            self.gi.value(), self.ev.value(),
            [self.env_r.value(), self.env_g.value(), self.env_b.value()],
            self.env_gain.value(), radius_px, occlusion_only=occl,
            lights_of_n=lights_cb)
        cy = iy - radius_px                    # 球心 = 脚下抬 char_wu/2
        self._probe_hit = (ix, cy, radius_px)  # 抓取命中区(自由移动)
        y0, y1 = cy - radius_px, cy + radius_px + 1
        x0, x1 = ix - radius_px, ix + radius_px + 1
        sy0, sx0 = max(0, -y0), max(0, -x0)
        y0, x0 = max(0, y0), max(0, x0)
        y1, x1 = min(h, y1), min(w, x1)
        if y1 <= y0 or x1 <= x0:
            return img
        out = img.copy()
        a = alpha[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0), None]
        out[y0:y1, x0:x1] = (out[y0:y1, x0:x1] * (1 - a)
                             + rgb[sy0:sy0 + (y1 - y0),
                                   sx0:sx0 + (x1 - x0)] * a)
        # §6.3 定量读数:探针体 2a₀ vs 脚下场景 2a₀(值一致 ⇒ 无缝隐没)
        a0f, _ = self.ctx['moments_smooth']
        scene_v = float(np.clip(2.0 * a0f[iy, ix], 0, 1))
        probe_v = float(np.clip(2.0 * sample['sky_a0'], 0, 1))
        self.note.setText(f'探针@({ix},{iy}) 体 2a₀={probe_v:.3f} vs '
                          f'场景 2a₀={scene_v:.3f}(|Δ|={abs(probe_v - scene_v):.3f},'
                          '§6.3 门:中位≤0.03)')
        return out

    def _render(self, *_a) -> None:
        if self.ctx is None or self.result is None:
            return
        self._probe_hit = None                # overlay 画了才有命中区
        self._char_hit = None
        try:
            img = self._channel_img()
            img = self._overlay_char(img)
            img = self._overlay_probe(img)
        except Exception as exc:                       # noqa: BLE001 — 显示不许炸
            img = self._placeholder(f'渲染失败:{type(exc).__name__}: {exc}')
        u8 = np.ascontiguousarray(
            np.round(np.clip(img, 0, 1) * 255).astype(np.uint8))
        h, w = u8.shape[:2]
        qi = QImage(u8.data, w, h, w * 3, QImage.Format_RGB888)
        pm = QPixmap.fromImage(qi).scaled(
            self.view.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        # 记录 视口→图像 的映射(点击放置探针要反算)
        s = pm.width() / float(w)
        offx = (self.view.width() - pm.width()) / 2.0
        offy = (self.view.height() - pm.height()) / 2.0
        self._view_map = (s, offx, offy, w, h)
        self.view.setPixmap(pm)

    def _img_xy(self, vx: float, vy: float) -> tuple | None:
        if self._view_map is None:
            return None
        s, offx, offy, w, h = self._view_map
        ix = (vx - offx) / max(s, 1e-9)
        iy = (vy - offy) / max(s, 1e-9)
        if not (0 <= ix < w and 0 <= iy < h):
            return None
        return int(ix), int(iy)

    def _on_view_click(self, vx: float, vy: float) -> None:
        pt = self._img_xy(vx, vy)
        if pt is None:
            return
        ix, iy = pt
        # ---- 自由移动:按在已画出的立绘/探针球身上 = 抓起来拖 ----
        # (抓取优先于一切放置模式 —— 移动现有对象不需要切勾)
        if self._char_hit is not None and self._char_foot is not None:
            x0, y0, x1, y1 = self._char_hit
            if x0 <= ix < x1 and y0 <= iy < y1:
                self._drag_target = 'char'
                self._drag_off = (self._char_foot[0] - ix,
                                  self._char_foot[1] - iy)
                return
        if self._probe_hit is not None and self._probe_px is not None:
            cx, cy, r = self._probe_hit
            if (ix - cx) ** 2 + (iy - cy) ** 2 <= r * r:
                self._drag_target = 'probe'
                self._drag_off = (self._probe_px[0] - ix,
                                  self._probe_px[1] - iy)
                return
        # ---- 空白处:放置(放灯 > 放角色 > 放探针),放下即可接着拖 ----
        l = self._light_sel()
        if (self.l_place.isChecked() and l is not None
                and l.get('kind') != 'directional'
                and self.ctx is not None
                and self.ctx.get('inp') is not None):
            inp = self.ctx['inp']
            if float(getattr(inp, 'scene_per_wu', 0) or 0) > 0:
                wpt = (inp.world[iy, ix].astype(np.float64)
                       * float(inp.scene_per_wu))     # q 尺度 → 作者面 wu
                l['pos'] = [round(float(wpt[0]), 1),
                            round(float(wpt[1]) + 75.0, 1),
                            round(float(wpt[2]), 1)]
                self._load_light_fields()
                self._lights_dirty()
                return
        if self.char_on.isChecked():
            self._char_foot = (ix, iy)
            self._drag_target = 'char'
            self._drag_off = (0, 0)
            self._render()
            return
        if not self.probe_on.isChecked():
            return
        self._probe_px = (ix, iy)
        self._drag_target = 'probe'
        self._drag_off = (0, 0)
        self._render()

    def _on_view_drag(self, vx: float, vy: float) -> None:
        if self._drag_target is None or self._view_map is None:
            return
        import time as _time
        s, offx, offy, w, h = self._view_map
        ix = int(np.clip((vx - offx) / max(s, 1e-9) + self._drag_off[0],
                         0, w - 1))
        iy = int(np.clip((vy - offy) / max(s, 1e-9) + self._drag_off[1],
                         0, h - 1))
        if self._drag_target == 'char':
            if self._char_foot == (ix, iy):
                return
            self._char_foot = (ix, iy)
        else:
            if self._probe_px == (ix, iy):
                return
            self._probe_px = (ix, iy)
        now = _time.monotonic()
        if now - self._last_drag_t < 0.03:        # 拖动节流:~33fps 重渲
            return
        self._last_drag_t = now
        self._render()

    def _on_view_release(self) -> None:
        if self._drag_target is not None:
            self._drag_target = None
            self._render()                        # 收尾补一帧(节流可能吞了末帧)

    def resizeEvent(self, event) -> None:               # noqa: N802 — Qt 命名
        super().resizeEvent(event)
        self._render()

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
        self.status.setText('全量 bake(只烘当前面板这一版参数):\n'
                            + self._cli_line_text())
        self._cancel_flag = False
        self.cancel_btn.setEnabled(True)
        spec = self._spec()
        kw = self._bake_kwargs()
        heavy = self.heavy_on.isChecked()
        sid = self.sid
        threads = self._threads

        def job():
            set_threads(threads)
            return bake_scene(sid, sky_override=spec, quiet=False,
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
        self._cancel_flag = True
        for w_ in [self.worker, self.bake_worker,
                   self._lights_worker] + list(self._retired):
            if w_ and w_.isRunning():
                if not w_.wait(8000):
                    self.status.setText('等待烘焙线程收尾……')
                    w_.wait()
        event.accept()


def create_window(sid: str, autobake: bool = True,
                  threads: int = 0) -> tuple[QApplication, Win]:
    """出窗不进事件循环(离屏测试从这里进)。"""
    app = QApplication.instance() or QApplication(sys.argv)
    win = Win(sid, autobake=autobake, threads=threads)
    return app, win


def run_gui(sid: str, threads: int = 0) -> int:
    app, win = create_window(sid, autobake=True, threads=threads)
    win.resize(1360, 800)
    win.show()
    return app.exec()
