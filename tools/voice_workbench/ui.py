"""配音工作台界面:左=源库,中=波形与切片,右=切片清单(筛选/状态/批量)与导出。

**右侧那张表是这个工具的主界面**,三条规矩定了它长什么样:

1. **状态列是算出来的**(``ledger.compute_status``),不是谁勾出来的。所以没有
   "已导出"复选框——那种复选框第一天就会和现实脱节。「产」那一栏表示的是
   "这条是不是产物"(底噪样本、废稿取消勾选),**不是**"这次导不导"。
2. **导出是一次查询**:范围下拉选「需要更新的」,按钮自己显示条数。隔一段时间
   导第二批,什么都不用勾,再按一次就是了。
3. **批量操作作用于选中**,而表是多选的;每个批量动作要么带三态(不动的项不动)、
   要么带预览(改名),因为批量最贵的一脚是"手滑一次全废"。

**波形用 pyqtgraph 的 LinearRegionItem**:拖边界调切点是这个工具的核心手感,
自绘 QPainter 要把命中测试、缩放、拖拽全写一遍,而 pyqtgraph 现成且流畅。

试听走 QMediaPlayer 放临时 wav——**每次生成新的临时文件名**:同名重写会命中
Qt 的解码缓存,听到的是上一版,让人以为参数没生效(tools/audio_editor 的壳注释里
记着同一个坑,那边是 WebEngine 的 HTTP 缓存,这边是媒体后端的文件缓存)。
"""
from __future__ import annotations

import json
import re
import tempfile
import uuid
from pathlib import Path

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import QItemSelection, QItemSelectionModel, Qt, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QKeySequence
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QDialog, QDoubleSpinBox,
    QFileDialog, QFormLayout, QGroupBox, QHBoxLayout, QHeaderView, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QMainWindow, QMessageBox,
    QPlainTextEdit, QProgressDialog, QPushButton, QSplitter, QTableWidget,
    QTableWidgetItem, QVBoxLayout, QWidget,
)

from . import audio_io as aio
from . import dsp
from . import ledger as ldg
from . import render as rnd
from .dialogs import BatchParamsDialog, RenameDialog, TagDialog
from .library import SourceLibrary, default_library_root
from .project import Project, Slice, clean_tags, projects_dir, sanitize_name

TOOL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOL_ROOT.parent.parent

#: 波形绘制的最大点数。48k×17s = 80 万点,直接画会卡;按包络降采样到这个量级足够看
_WAVE_POINTS = 4000

#: 切片表的列。**用常量不用魔数**:这张表加过一次列,散在六处的 `item(row, 4)`
#: 当时全靠人肉对齐,漏一处就是"改降噪却改成了改名"。
COL_ON, COL_NAME, COL_STATE, COL_DUR, COL_DENOISE, COL_TAGS = range(6)

#: 导出范围。**导出是一次查询,不是一次打钩**——
#: "第二批"永远只是再按一次"需要更新的",不需要把上一批的钩子取消掉。
SCOPE_NEEDED = "需要更新的"
SCOPE_SELECTED = "选中的"
SCOPE_FILTERED = "当前筛选的"
SCOPE_ALL = "全部（强制重渲）"

#: 状态筛选项(下拉里的顺序)
FILTER_ALL = "全部状态"
FILTER_NEEDED = "需要更新"
_FILTER_STATES = {
    "最新": ldg.STATE_CURRENT,
    "已过时": ldg.STATE_STALE,
    "未导出": ldg.STATE_NEVER,
    "产物丢了": ldg.STATE_MISSING,
    "被改过": ldg.STATE_MODIFIED,
    "来历不明": ldg.STATE_FOREIGN,
    "源不在": ldg.STATE_NO_SOURCE,
    "不产": ldg.STATE_EXCLUDED,
}

_NO_TAG = "（没有标签）"


def _envelope(x: np.ndarray, points: int = _WAVE_POINTS) -> tuple[np.ndarray, np.ndarray]:
    """min/max 包络降采样:直接抽样会漏掉尖峰,看起来像没削顶其实削了。"""
    mono = x.mean(axis=1) if x.ndim > 1 else x
    n = mono.size
    if n == 0:
        return np.zeros(0), np.zeros(0)
    step = max(1, n // points)
    usable = (n // step) * step
    blocks = mono[:usable].reshape(-1, step)
    return blocks.min(axis=1), blocks.max(axis=1)


class VoiceWorkbench(QMainWindow):
    def __init__(self, repo_root: Path = REPO_ROOT, state_dir: Path | None = None):
        """``state_dir``：工程 / 自动存盘 / 界面状态的落脚点，缺省即工具目录。
        测试传临时目录——否则跑一次测试就往真实工程目录里塞垃圾。"""
        super().__init__()
        self.setWindowTitle("配音工作台")
        self.resize(1500, 900)
        self.repo_root = Path(repo_root)
        self.state_dir = Path(state_dir) if state_dir else TOOL_ROOT
        self.lib = SourceLibrary(default_library_root(self.repo_root))
        self.project = Project()
        self.project_path: Path | None = None
        self.cache = rnd.SourceCache(self.lib)
        #: 产物记账 + 状态。**状态永远是算出来的**,界面上没有任何"已导出"复选框
        self.ledger = ldg.Ledger()
        self.sha_cache = ldg.SourceShaCache()
        self._status: dict[str, ldg.SliceStatus] = {}
        #: 当前筛选之后显示在表里的切片(表格行 ↔ 工程下标不再一一对应)
        self._visible: list[Slice] = []
        self._current_rel: str = ""
        self._current_audio: aio.Audio | None = None
        self._regions: dict[str, pg.LinearRegionItem] = {}
        self._syncing = False
        self._tmp_dir = Path(tempfile.mkdtemp(prefix="voice_wb_"))
        self._player = QMediaPlayer(self)
        self._audio_out = QAudioOutput(self)
        self._player.setAudioOutput(self._audio_out)

        self._saved_json = ""
        self._build_menu()
        self._build_ui()
        self.refresh_sources()
        self._refresh_slices()
        self._mark_saved()
        # **构造期绝不弹模态框**：离屏跑测试时 exec() 永不返回，整跑挂死
        #（仓库文档明写过这条，我还是踩了）。恢复上次会话是显式一步，由入口在
        # show() 之后调 restore_session()，测试不调就不会有弹窗。
        self._autosave_timer = QTimer(self)
        self._autosave_timer.timeout.connect(self._autosave)
        self._autosave_timer.start(30_000)

    # ------------------------------------------------------------------ 构建

    def _build_menu(self) -> None:
        m = self.menuBar().addMenu("工程")
        for text, slot, key in (
            ("新建", self.new_project, QKeySequence.StandardKey.New),
            ("打开…", self.open_project, QKeySequence.StandardKey.Open),
            ("保存", self.save_project, QKeySequence.StandardKey.Save),
            ("另存为…", self.save_project_as, QKeySequence("Ctrl+Shift+S")),
        ):
            act = QAction(text, self)
            act.setShortcut(key)
            act.triggered.connect(slot)
            m.addAction(act)
        mm = self.menuBar().addMenu("源库")
        for text, slot in (
            ("导入音频…", self.import_sources),
            ("打开源库目录", self.open_library_dir),
            ("完整性检查", self.check_library),
        ):
            act = QAction(text, self)
            act.triggered.connect(slot)
            mm.addAction(act)
        pm = self.menuBar().addMenu("产物")
        for text, slot, key in (
            ("重新扫描状态", self.rescan_status, QKeySequence("F5")),
            ("按现状认账…", self.claim_existing, None),
            ("导出目录在哪", self.show_export_dir, None),
        ):
            act = QAction(text, self)
            if key is not None:
                act.setShortcut(key)
            act.triggered.connect(slot)
            pm.addAction(act)

    def _build_ui(self) -> None:
        split = QSplitter(Qt.Orientation.Horizontal, self)

        # --- 左：源库 ---
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(6, 6, 6, 6)
        lv.addWidget(QLabel("源库（原始录音，只增不改）"))
        self.source_list = QListWidget()
        self.source_list.currentItemChanged.connect(lambda *_: self.load_selected_source())
        lv.addWidget(self.source_list, 1)
        btn_import = QPushButton("导入音频…")
        btn_import.clicked.connect(self.import_sources)
        lv.addWidget(btn_import)
        self.source_info = QLabel("—")
        self.source_info.setWordWrap(True)
        self.source_info.setStyleSheet("color: gray;")
        lv.addWidget(self.source_info)
        split.addWidget(left)

        # --- 中：波形 ---
        mid = QWidget()
        mv = QVBoxLayout(mid)
        mv.setContentsMargins(6, 6, 6, 6)
        pg.setConfigOptions(antialias=True)
        self.plot = pg.PlotWidget()
        self.plot.setLabel("bottom", "秒")
        self.plot.showGrid(x=True, y=False, alpha=0.3)
        vb = self.plot.getViewBox()
        # **纵轴锁死在 ±1 满刻度**：波形图的纵轴是"音量刻度"，不是可缩放的视图。
        # 不锁的话中键/滚轮会连纵轴一起缩——越缩越平，最后波形被压成一根直线，
        # 看起来像素材坏了。横轴照常缩放平移（那才是看波形要的）。
        vb.setMouseEnabled(x=True, y=False)
        vb.setYRange(-1.0, 1.0, padding=0.05)
        vb.setLimits(yMin=-1.05, yMax=1.05)
        vb.disableAutoRange(axis=pg.ViewBox.YAxis)
        self.wave = self.plot.plot([], [], pen=pg.mkPen("#4dabf7"))
        mv.addWidget(self.plot, 1)

        tools = QHBoxLayout()
        tools.addWidget(QLabel("静音门限"))
        self.split_thr = QDoubleSpinBox()
        self.split_thr.setRange(-70, -10)
        self.split_thr.setDecimals(0)
        self.split_thr.setSuffix(" dB")
        self.split_thr.setValue(dsp.DEFAULT_SPLIT_THRESHOLD_DB)
        self.split_thr.setToolTip(
            "低于这个电平算静音。家庭录音的房间本底常在 -45 dB 上下，"
            "门限压到那儿等于'全程都不算静音'，整条会切不开。"
        )
        tools.addWidget(self.split_thr)
        tools.addWidget(QLabel("最短静音"))
        self.split_gap = QDoubleSpinBox()
        self.split_gap.setRange(0.1, 5.0)
        self.split_gap.setSingleStep(0.1)
        self.split_gap.setSuffix(" 秒")
        self.split_gap.setValue(dsp.DEFAULT_MIN_SILENCE_S)
        self.split_gap.setToolTip("停顿短于这个值的两句会连在一起——那时在波形上自己再拖一刀。")
        tools.addWidget(self.split_gap)
        btn_auto = QPushButton("建议切点")
        btn_auto.setToolTip(
            "只给'一次录了一整段'的源用：按静音**建议**切点，边界随后可拖。\n"
            "它从不改动音频本身，也绝不自动跑；已有切片会先问过你再替换。"
        )
        btn_auto.clicked.connect(self.auto_split)
        tools.addWidget(btn_auto)
        btn_add = QPushButton("加一段")
        btn_add.clicked.connect(self.add_slice_here)
        tools.addWidget(btn_add)
        btn_noise = QPushButton("设为底噪样本")
        btn_noise.setToolTip(
            "把当前选中切片的区间标成'纯底噪'，供降噪当参考。\n"
            "录音时那 10 秒空房间就是留给这里的——比让算法自己猜准得多。"
        )
        btn_noise.clicked.connect(self.mark_noise_sample)
        tools.addWidget(btn_noise)
        tools.addStretch(1)
        mv.addLayout(tools)

        play = QHBoxLayout()
        for text, tip, slot in (
            ("▶ 试听原始", "播放选中切片的原始声音（不处理）", lambda: self.preview(False)),
            ("▶ 试听处理后", "播放降噪 + 归一化之后的效果", lambda: self.preview(True)),
            ("■ 停", "", self._player.stop),
        ):
            b = QPushButton(text)
            b.setToolTip(tip)
            b.clicked.connect(slot)
            play.addWidget(b)
        self.preview_info = QLabel("—")
        self.preview_info.setStyleSheet("color: gray;")
        play.addWidget(self.preview_info, 1)
        mv.addLayout(play)
        split.addWidget(mid)

        # --- 右：切片清单 + 参数 ---
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(6, 6, 6, 6)
        rv.addWidget(QLabel("切片（每条 = 一个产物）"))

        # --- 筛选栏：四个维度求交。筛选只影响"显示"与"作用于筛选结果"的批量操作 ---
        f1 = QHBoxLayout()
        self.filter_text = QLineEdit()
        self.filter_text.setPlaceholderText("搜产物名 / 标签 / 备注…")
        self.filter_text.setClearButtonEnabled(True)
        # **一律用 lambda 吃掉信号参数**：textChanged 会把文本、currentIndexChanged 会把
        # 下标当第一个实参递进来，直接连到带默认参数的槽会把它当成 recompute 用
        self.filter_text.textChanged.connect(lambda *_: self._refilter())
        f1.addWidget(self.filter_text, 1)
        self.filter_state = QComboBox()
        self.filter_state.setToolTip("状态是算出来的：产物在不在、是不是当前参数渲的")
        self.filter_state.addItem(FILTER_ALL)
        self.filter_state.addItem(FILTER_NEEDED)
        for label in _FILTER_STATES:
            self.filter_state.addItem(label)
        self.filter_state.currentIndexChanged.connect(lambda *_: self._refilter())
        f1.addWidget(self.filter_state)
        rv.addLayout(f1)

        f2 = QHBoxLayout()
        self.filter_tag = QComboBox()
        self.filter_tag.setToolTip("标签是自由词表：用没了的标签自己就消失，不用管理")
        self.filter_tag.currentIndexChanged.connect(lambda *_: self._refilter())
        f2.addWidget(self.filter_tag, 1)
        self.filter_source = QComboBox()
        self.filter_source.currentIndexChanged.connect(lambda *_: self._refilter())
        f2.addWidget(self.filter_source, 1)
        self.count_label = QLabel("")
        self.count_label.setStyleSheet("color: gray;")
        f2.addWidget(self.count_label)
        rv.addLayout(f2)

        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["产", "产物名", "状态", "时长", "降噪", "标签"])
        self.table.horizontalHeader().setSectionResizeMode(COL_NAME, QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        # **多选**：批量操作是这张表的日常，单选模式下"选中的"这个概念根本不成立
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.itemChanged.connect(self._on_table_edited)
        self.table.itemSelectionChanged.connect(self._on_table_selected)
        # 行号在筛选之后是"第几行"而不是"第几条"，会误导；藏掉还能给窄面板省 30px
        self.table.verticalHeader().setVisible(False)
        # 长名字换行会把行高撑成两倍，一屏少看一半；截断也不能截尾巴——
        # 这批名字只有尾号不同（开场茶馆_瞎子李_1 / _12），截尾就全长一个样了
        self.table.setWordWrap(False)
        self.table.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        # **这张表是主工作面,必须优先占高度**:不给下限的话,1180×700 的屏上
        # 底下那两个组会把它挤成三行(实测),清单一眼看不到三条以上就没法挑批次了
        self.table.setMinimumHeight(200)
        rv.addWidget(self.table, 5)

        row = QHBoxLayout()
        for text, tip, slot in (
            ("删除", "删掉选中的切片（已导出的产物不会被删，只会提示它变成孤儿）", self.delete_selected),
            ("重命名…", "模板或查找替换，带预览与冲突检查；已导出的默认连带改名磁盘产物", self.batch_rename),
            ("标签…", "给选中的一批打/去标签（三态：半选＝保持原样）", self.batch_tags),
            ("参数…", "批量改产出/降噪/增益/淡入淡出（没勾「改」的项一律不动）", self.batch_params),
        ):
            b = QPushButton(text)
            b.setToolTip(tip)
            b.clicked.connect(slot)
            row.addWidget(b)
        rv.addLayout(row)

        box = QGroupBox("这一批的处理参数")
        form = QFormLayout(box)
        self.target_lufs = QDoubleSpinBox()
        self.target_lufs.setRange(-40, -5)
        self.target_lufs.setDecimals(1)
        self.target_lufs.setSuffix(" LUFS")
        self.target_lufs.setValue(self.project.settings.target_lufs)
        self.target_lufs.setToolTip(
            "对白响度目标。整体混音跑 -23 LUFS 时对白通常落在 -20 上下；\n"
            "数字本身不重要，重要的是**一批素材用同一个数**——对齐靠的是这个。"
        )
        form.addRow("响度目标", self.target_lufs)
        self.ceiling = QDoubleSpinBox()
        self.ceiling.setRange(-6, 0)
        self.ceiling.setDecimals(1)
        self.ceiling.setSuffix(" dBTP")
        self.ceiling.setValue(self.project.settings.true_peak_ceiling_db)
        self.ceiling.setToolTip("真峰上限。到顶就不再往上推——宁可这条没到响度目标，也不削顶。")
        form.addRow("真峰上限", self.ceiling)
        self.denoise_db = QDoubleSpinBox()
        self.denoise_db.setRange(0, 30)
        self.denoise_db.setDecimals(0)
        self.denoise_db.setSuffix(" dB")
        self.denoise_db.setValue(self.project.settings.denoise_reduction_db)
        self.denoise_db.setToolTip("降噪量。0 = 不降噪；12 dB 是干净又自然的常规值，越大越容易啃掉气声。")
        form.addRow("降噪", self.denoise_db)
        self.mono = QCheckBox("导出转单声道")
        self.mono.setChecked(self.project.settings.export_mono)
        self.mono.setToolTip("手机录的'立体声'是双份同内容，转单声道省一半体积且不损失任何东西。")
        form.addRow("", self.mono)
        self.bits = QComboBox()
        self.bits.addItems(["16", "24"])
        self.bits.setToolTip("16bit 动态 96 dB，对配音足够。")
        form.addRow("位深", self.bits)
        self.noise_label = QLabel("未设置")
        self.noise_label.setStyleSheet("color: gray;")
        form.addRow("底噪样本", self.noise_label)
        rv.addWidget(box)

        exp = QGroupBox("导出")
        ev = QVBoxLayout(exp)
        r1 = QHBoxLayout()
        self.export_dir = QLineEdit(self.project.settings.export_dir)
        self.export_dir.setToolTip("相对仓库根。产物是唯一进游戏的东西，所以默认落在 public 下。")
        self.export_dir.editingFinished.connect(self.rescan_status)
        r1.addWidget(self.export_dir, 1)
        b_browse = QPushButton("…")
        b_browse.setMaximumWidth(32)
        b_browse.clicked.connect(self.pick_export_dir)
        r1.addWidget(b_browse)
        ev.addLayout(r1)

        r2 = QHBoxLayout()
        r2.addWidget(QLabel("范围"))
        self.export_scope = QComboBox()
        self.export_scope.addItems([SCOPE_NEEDED, SCOPE_SELECTED, SCOPE_FILTERED, SCOPE_ALL])
        self.export_scope.setToolTip(
            "「需要更新的」＝没导过的 + 参数变过的 + 产物丢了的。\n"
            "隔一段时间要导第二批，什么都不用勾，再按一次就是了。"
        )
        self.export_scope.currentIndexChanged.connect(lambda *_: self._update_export_button())
        r2.addWidget(self.export_scope, 1)
        b_rescan = QPushButton("⟳")
        b_rescan.setMaximumWidth(32)
        b_rescan.setToolTip("重新扫描产物状态（F5）")
        b_rescan.clicked.connect(self.rescan_status)
        r2.addWidget(b_rescan)
        ev.addLayout(r2)

        self.btn_export = QPushButton("导出")
        self.btn_export.clicked.connect(self.export_all)
        ev.addWidget(self.btn_export)
        self.report = QPlainTextEdit()
        self.report.setReadOnly(True)
        self.report.setMinimumHeight(60)
        self.report.setMaximumHeight(120)
        self.report.setPlaceholderText("导出报告会显示在这里：每条量到多少、加了多少增益、有没有被真峰拦住。")
        ev.addWidget(self.report)
        rv.addWidget(exp)
        split.addWidget(right)

        split.setSizes([260, 760, 460])
        self.setCentralWidget(split)
        self.statusBar().showMessage("就绪")

    # ------------------------------------------------------------------ 源库

    def refresh_sources(self) -> None:
        self.source_list.clear()
        for p in self.lib.scan():
            rel = self.lib.rel_of(p)
            it = QListWidgetItem(rel)
            it.setData(Qt.ItemDataRole.UserRole, rel)
            self.source_list.addItem(it)
        self.statusBar().showMessage(f"源库 {self.source_list.count()} 条")

    def import_sources(self) -> None:
        exts = " ".join(f"*{e}" for e in aio.SUPPORTED_EXT)
        files, _ = QFileDialog.getOpenFileNames(self, "导入原始录音", "", f"音频 ({exts})")
        if not files:
            return
        added, skipped, errors = self.lib.import_many([Path(f) for f in files])
        self.refresh_sources()
        msg = f"新导入 {len(added)} 条"
        if skipped:
            msg += f"，已在库中跳过 {len(skipped)} 条"
        if errors:
            msg += f"，{len(errors)} 条失败"
            QMessageBox.warning(self, "部分文件没能导入", "\n".join(errors))
        self.statusBar().showMessage(msg)

    def open_library_dir(self) -> None:
        self.lib.root.mkdir(parents=True, exist_ok=True)
        QMessageBox.information(self, "源库位置", str(self.lib.root))

    def check_library(self) -> None:
        problems = self.lib.verify()
        if not problems:
            QMessageBox.information(self, "完整性检查", "全部正常：库内文件与导入记录一致。")
        else:
            QMessageBox.warning(self, "完整性检查", "\n".join(problems))

    def load_selected_source(self) -> None:
        it = self.source_list.currentItem()
        if it is None:
            return
        rel = str(it.data(Qt.ItemDataRole.UserRole))
        try:
            audio = self.cache.get(rel)
        except (aio.AudioIOError, OSError) as ex:
            QMessageBox.warning(self, "读不了这条源", str(ex))
            return
        self._current_rel, self._current_audio = rel, audio
        lo, hi = _envelope(audio.samples)
        t = np.linspace(0, audio.seconds, lo.size)
        self.wave.setData(np.repeat(t, 2), np.column_stack([lo, hi]).reshape(-1))
        self.plot.setXRange(0, max(audio.seconds, 0.01))
        self.plot.getViewBox().setYRange(-1.0, 1.0, padding=0.05)
        loud = dsp.loudness_lufs(audio.samples, audio.rate)
        self.source_info.setText(
            f"{audio.seconds:.2f}s · {audio.rate}Hz · {audio.channels}ch · "
            f"{audio.source_bits or '?'}bit · {loud:+.1f} LUFS"
        )
        self._rebuild_regions()

    # ------------------------------------------------------------------ 切片

    def _rebuild_regions(self) -> None:
        for r in self._regions.values():
            self.plot.removeItem(r)
        self._regions.clear()
        if not self._current_rel:
            return
        for s in self.project.slices_of(self._current_rel):
            region = pg.LinearRegionItem(values=(s.start, s.end), brush=pg.mkBrush(80, 200, 120, 50))
            region.setZValue(-10)
            region.sigRegionChangeFinished.connect(
                lambda r=region, sid=s.id: self._on_region_dragged(sid, r)
            )
            self.plot.addItem(region)
            self._regions[s.id] = region
        self._highlight_regions()      # 换一条源之后，选中态也要跟着画出来

    def _on_region_dragged(self, slice_id: str, region: pg.LinearRegionItem) -> None:
        lo, hi = region.getRegion()
        self.project.update(slice_id, start=round(float(lo), 3), end=round(float(hi), 3))
        self._refresh_slices()

    def auto_split(self) -> None:
        """按静音**建议**切点。只给"一次录了一整段"的源用。

        两条硬规矩(用户明令):
        1. **绝不自动跑**——只有按了这个按钮才会有切点建议;
        2. **绝不静默顶掉已有切片**——手工调过的边界是人的劳动,覆盖前必须确认。
        它只是往清单里加区间,**从不改动音频本身**;真正决定产物边界的永远是清单里的数。
        """
        if self._current_audio is None:
            QMessageBox.information(self, "建议切点", "先在左边选一条源。")
            return
        existing = self.project.slices_of(self._current_rel)
        if existing:
            r = QMessageBox.question(
                self, "建议切点",
                f"这条源已经有 {len(existing)} 个切片（可能是你手工调过的）。\n"
                f"继续会把它们全部替换成机器建议的切点。要继续吗？",
                QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            if r != QMessageBox.StandardButton.Ok:
                return
        segs = dsp.split_on_silence(
            self._current_audio.samples, self._current_audio.rate,
            threshold_db=self.split_thr.value(), min_silence_s=self.split_gap.value(),
        )
        if not segs:
            QMessageBox.information(self, "建议切点", "没切出东西——试着把静音门限调高一点。")
            return
        self.project.slices = [s for s in self.project.slices if s.source != self._current_rel]
        stem = Path(self._current_rel).stem
        for i, (a, b) in enumerate(segs, 1):
            # 机器切出来的切口是硬边，给一点淡入淡出；手工/整条导入的一律 0（不动用户的边界）
            self.project.add_slice(Slice(
                source=self._current_rel, start=a, end=b, name=f"{stem}_{i}",
                fade_in_s=0.01, fade_out_s=0.02,
            ))
        self._rebuild_regions()
        self._refresh_slices()
        self.statusBar().showMessage(f"建议了 {len(segs)} 个切点（边界可在波形上拖）")

    def add_slice_here(self) -> None:
        if self._current_audio is None:
            return
        view = self.plot.viewRange()[0]
        a = max(0.0, float(view[0]))
        b = min(self._current_audio.seconds, float(view[1]))
        mid = (a + b) / 2
        half = min(1.0, (b - a) / 4) or 0.5
        stem = Path(self._current_rel).stem
        n = len(self.project.slices_of(self._current_rel)) + 1
        self.project.add_slice(Slice(
            source=self._current_rel, start=round(mid - half, 3), end=round(mid + half, 3),
            name=f"{stem}_{n}",
        ))  # 淡入淡出留 0：边界是人自己拖的，不替他做主
        self._rebuild_regions()
        self._refresh_slices()

    def _selected_slices(self) -> list[Slice]:
        """选中的那些,**按工程内顺序**返回(不是按点击顺序——批量改名的序号靠它)。"""
        model = self.table.selectionModel()
        rows = model.selectedRows() if model else []
        ids = set()
        for idx in rows:
            item = self.table.item(idx.row(), COL_NAME)
            if item is not None:
                ids.add(str(item.data(Qt.ItemDataRole.UserRole)))
        return [s for s in self.project.slices if s.id in ids]

    def _selected_slice(self) -> Slice | None:
        """只认一条的场合(试听、设底噪样本)取选中的第一条。"""
        got = self._selected_slices()
        return got[0] if got else None

    def mark_noise_sample(self) -> None:
        s = self._selected_slice()
        if s is None:
            QMessageBox.information(self, "底噪样本", "先在右边选一条切片，把它标成纯底噪。")
            return
        self.project.settings.noise_source = s.source
        self.project.settings.noise_start = s.start
        self.project.settings.noise_end = s.end
        self.noise_label.setText(f"{Path(s.source).name} {s.start:.2f}–{s.end:.2f}s")
        self.statusBar().showMessage("已设为底噪样本（这条切片本身通常应取消勾选「产」）")

    # -------------------------------------------------------------- 产物状态

    def _out_dir(self) -> Path:
        return ldg.resolve_out_dir(self.repo_root, self.export_dir.text().strip())

    def _ledger_path(self) -> Path | None:
        return ldg.ledger_path_for(self.project_path)

    def _save_ledger(self) -> None:
        """记账落盘。**与工程分开写**:它是机器写的事实,混进工程 json 会让
        每次导出都把工程翻脏,于是"什么都没干关闭却弹保存"。"""
        try:
            self.ledger.save(self._ledger_path())
        except OSError:
            pass                       # 记账写不出去不该打断正在干活的人（下次扫描会重算）

    def _recompute_status(self) -> None:
        self._sync_settings()
        self._status = ldg.compute_all(
            self.project, self.lib, self.ledger, self._out_dir(),
            repo_root=self.repo_root, sha_cache=self.sha_cache,
        )
        if self.ledger.dirty:           # 扫描只可能刷新 sha 缓存键，顺手落一次
            self._save_ledger()

    def status_of(self, sl: Slice) -> ldg.SliceStatus:
        return self._status.get(sl.id) or ldg.SliceStatus(ldg.STATE_NEVER)

    def rescan_status(self) -> None:
        """重新扫描:源与产物都当作可能被外部改过,sha 缓存全部作废重算。"""
        self.sha_cache.clear()
        self._refresh_slices()
        counts: dict[str, int] = {}
        for st in self._status.values():
            counts[st.label] = counts.get(st.label, 0) + 1
        msg = "、".join(f"{k} {v}" for k, v in counts.items()) or "工程里还没有切片"
        # 记账是后来才有的：老工程第一次打开必然满屏"来历不明"，
        # 那时最该告诉人的是"按哪一下就好了"，而不是让他盯着一列灰字发愣
        if not len(self.ledger) and counts.get(ldg.STATE_LABELS[ldg.STATE_FOREIGN]):
            msg += "　——这些产物在盘上但还没有记账，「产物 → 按现状认账」认一次就归位"
        self.statusBar().showMessage(msg)

    def show_export_dir(self) -> None:
        QMessageBox.information(self, "导出目录", str(self._out_dir()))

    def claim_existing(self) -> None:
        """把导出目录里已有的同名文件认作当前参数的产物。

        这条是给**记账上线之前就已经导出去的那一批**准备的迁移动作:
        它们在盘上、在游戏里用着,只是本工具没有它们的账。
        """
        self._recompute_status()
        foreign = [s for s in self.project.slices if self.status_of(s).state == ldg.STATE_FOREIGN]
        if not foreign:
            QMessageBox.information(self, "按现状认账", "没有「来历不明」的产物，不用认。")
            return
        names = "、".join(s.name for s in foreign[:8]) + ("…" if len(foreign) > 8 else "")
        r = QMessageBox.question(
            self, "按现状认账",
            f"把导出目录里这 {len(foreign)} 个同名文件，认作**当前参数**渲出来的产物：\n\n{names}\n\n"
            f"认账之后它们显示「最新」，不会再进「需要更新的」。\n"
            f"如果你其实改过参数、盘上那些是旧的，就别认——直接导一次更实在。\n\n"
            f"（只动记账，不碰任何音频文件）",
            QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel,
        )
        if r != QMessageBox.StandardButton.Ok:
            return
        claimed = ldg.claim_existing(
            self.project, self.lib, self.ledger, self._out_dir(),
            repo_root=self.repo_root, sha_cache=self.sha_cache,
        )
        self._save_ledger()
        self._refresh_slices()
        self.statusBar().showMessage(f"认下了 {len(claimed)} 条产物")

    # ---------------------------------------------------------------- 筛选

    def _sync_filter_choices(self) -> None:
        """标签/源两个下拉的候选来自工程本身。**保住当前选择**——
        每次刷新把人的筛选顶掉,等于筛选栏不能用。"""
        for combo, head, values in (
            (self.filter_tag, "全部标签", self.project.all_tags() + [_NO_TAG]),
            (self.filter_source, "全部源", self.project.sources_used()),
        ):
            want = combo.currentText()
            items = [head] + list(values)
            if [combo.itemText(i) for i in range(combo.count())] == items:
                continue
            blocked = combo.blockSignals(True)
            combo.clear()
            combo.addItems(items)
            idx = combo.findText(want)
            combo.setCurrentIndex(idx if idx >= 0 else 0)
            combo.blockSignals(blocked)

    def _passes_filter(self, s: Slice) -> bool:
        text = self.filter_text.text().strip().lower()
        if text:
            hay = " ".join([s.name, s.note, " ".join(s.tags)]).lower()
            if text not in hay:
                return False
        state_label = self.filter_state.currentText()
        if state_label == FILTER_NEEDED:
            if not self.status_of(s).needs_export:
                return False
        elif state_label != FILTER_ALL:
            if self.status_of(s).state != _FILTER_STATES.get(state_label):
                return False
        tag = self.filter_tag.currentText()
        if tag == _NO_TAG:
            if s.tags:
                return False
        elif tag and tag != "全部标签" and not s.has_tag(tag):
            return False
        src = self.filter_source.currentText()
        if src and src != "全部源" and s.source != src:
            return False
        return True

    def _refilter(self) -> None:
        """只重排表,不重扫磁盘。**筛选是敲键盘的事**——每敲一个字就去 stat 一遍
        导出目录,几百条切片时手感立刻就垮了。"""
        self._refresh_slices(recompute=False)

    def _refresh_slices(self, recompute: bool = True) -> None:
        if recompute:
            self._recompute_status()
        self._sync_filter_choices()
        self._visible = [s for s in self.project.slices if self._passes_filter(s)]
        keep = {s.id for s in self._selected_slices()}
        self._syncing = True
        try:
            self.table.setRowCount(len(self._visible))
            for i, s in enumerate(self._visible):
                st = self.status_of(s)
                chk = QTableWidgetItem()
                chk.setFlags(chk.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                chk.setCheckState(Qt.CheckState.Checked if s.enabled else Qt.CheckState.Unchecked)
                chk.setToolTip("勾上＝这条是产物。底噪样本、废稿取消勾选（这不是「这次导不导」）")
                self.table.setItem(i, COL_ON, chk)

                name = QTableWidgetItem(s.name)
                name.setData(Qt.ItemDataRole.UserRole, s.id)
                name.setToolTip(f"产物文件：{s.name}.wav")
                self.table.setItem(i, COL_NAME, name)

                state = QTableWidgetItem(st.label)
                state.setFlags(state.flags() & ~Qt.ItemFlag.ItemIsEditable)
                state.setForeground(QColor(st.color))
                state.setToolTip(st.reason + (f"\n改名前的产物还在：{st.orphan}" if st.orphan else ""))
                self.table.setItem(i, COL_STATE, state)

                dur = QTableWidgetItem(f"{s.seconds:.2f}s")
                dur.setFlags(dur.flags() & ~Qt.ItemFlag.ItemIsEditable)
                dur.setToolTip(f"{s.start:.2f}s → {s.end:.2f}s（在波形上拖边界改）")
                self.table.setItem(i, COL_DUR, dur)

                dn = QTableWidgetItem()
                dn.setFlags(dn.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                dn.setCheckState(Qt.CheckState.Checked if s.denoise else Qt.CheckState.Unchecked)
                self.table.setItem(i, COL_DENOISE, dn)

                tags = QTableWidgetItem("，".join(s.tags))
                tags.setToolTip("直接改也行（逗号分隔），批量打标签用下面的「标签…」")
                self.table.setItem(i, COL_TAGS, tags)
            self.table.resizeColumnsToContents()
            self.table.horizontalHeader().setSectionResizeMode(COL_NAME, QHeaderView.ResizeMode.Stretch)
            self._restore_selection(keep)
        finally:
            self._syncing = False
        total, shown = len(self.project.slices), len(self._visible)
        self.count_label.setText(f"{shown}/{total}" if shown != total else f"{total} 条")
        self._update_export_button()
        self._highlight_regions()

    def _restore_selection(self, ids: set[str]) -> None:
        """刷新表之后把选择还回去——不然改一次名字选择就没了,批量操作要重新点一遍。

        **不能挨个 selectRow**:扩展选择模式下它是 ClearAndSelect,一行行选下来
        只会剩最后一行(踩过:批量改完参数,选中的 12 条变成 1 条)。一次性提交整片选区。
        """
        if not ids:
            return
        model = self.table.model()
        sel = QItemSelection()
        last = self.table.columnCount() - 1
        for i, s in enumerate(self._visible):
            if s.id in ids:
                sel.select(model.index(i, 0), model.index(i, last))
        self.table.selectionModel().select(
            sel, QItemSelectionModel.SelectionFlag.ClearAndSelect
        )

    def _on_table_edited(self, item: QTableWidgetItem) -> None:
        if self._syncing:
            return
        name_item = self.table.item(item.row(), COL_NAME)
        if name_item is None:
            return
        sid = str(name_item.data(Qt.ItemDataRole.UserRole))
        col = item.column()
        if col == COL_ON:
            self.project.update(sid, enabled=item.checkState() == Qt.CheckState.Checked)
        elif col == COL_NAME:
            self.project.update(sid, name=sanitize_name(item.text()))
        elif col == COL_DENOISE:
            self.project.update(sid, denoise=item.checkState() == Qt.CheckState.Checked)
        elif col == COL_TAGS:
            self.project.update(sid, tags=clean_tags(re.split(r"[,，]", item.text())))
        else:
            return
        # **改完要重算状态**（改名/改参数都会让产物过时），但不能在 itemChanged
        # 派发过程中重建整张表——推到事件循环下一轮
        QTimer.singleShot(0, self._refresh_slices)

    def _on_table_selected(self) -> None:
        if self._syncing:
            return
        self._highlight_regions()
        got = self._selected_slices()
        self._update_export_button()
        if len(got) != 1:
            return                        # 多选时别乱跳视图：那是在挑一批，不是在看某一条
        s = got[0]
        if s.source != self._current_rel:
            for i in range(self.source_list.count()):
                it = self.source_list.item(i)
                if str(it.data(Qt.ItemDataRole.UserRole)) == s.source:
                    self.source_list.setCurrentItem(it)
                    break
        self.plot.setXRange(max(0.0, s.start - 0.5), s.end + 0.5)

    def _highlight_regions(self) -> None:
        """选中的波形区间画亮一点,其余压暗——多选时才看得出"这一批是哪几段"。"""
        chosen = {s.id for s in self._selected_slices()}
        for sid, region in self._regions.items():
            region.setBrush(
                pg.mkBrush(80, 200, 120, 110) if sid in chosen else pg.mkBrush(80, 200, 120, 40)
            )
            region.update()

    # ------------------------------------------------------------ 批量动作

    def _need_selection(self, what: str) -> list[Slice]:
        got = self._selected_slices()
        if not got:
            QMessageBox.information(self, what, "先在清单里选中一条或多条（按住 Ctrl / Shift 可多选）。")
        return got

    def delete_selected(self) -> None:
        got = self._need_selection("删除")
        if not got:
            return
        orphans = [
            self.status_of(s).dest for s in got
            if self.status_of(s).dest is not None and self.status_of(s).dest.is_file()
        ]
        if len(got) > 1 or orphans:
            note = ""
            if orphans:
                note = (
                    f"\n\n注意：其中 {len(orphans)} 条已经导出过。"
                    f"\n**磁盘上的产物不会被删**（它可能正被 audio_config 引用着），"
                    f"\n删完之后它们就没人管了，要清理请自己去导出目录处理。"
                )
            r = QMessageBox.question(
                self, "删除切片",
                f"要删掉这 {len(got)} 条切片吗？{note}",
                QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            if r != QMessageBox.StandardButton.Ok:
                return
        for s in got:
            self.project.remove(s.id)
        self._rebuild_regions()
        self._refresh_slices()
        self.statusBar().showMessage(f"删了 {len(got)} 条切片" + ("（磁盘上的产物原样留着）" if orphans else ""))

    def batch_tags(self) -> None:
        got = self._need_selection("打标签")
        if not got:
            return
        dlg = TagDialog(self, got, self.project.all_tags())
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        for s in got:
            self.project.update(s.id, tags=dlg.apply_to(s))
        self._refresh_slices()
        self.statusBar().showMessage(f"改了 {len(got)} 条的标签")

    def batch_params(self) -> None:
        got = self._need_selection("批量改参数")
        if not got:
            return
        dlg = BatchParamsDialog(self, got)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        changes = dlg.changes()
        if not changes:
            self.statusBar().showMessage("没勾任何一项，什么都没改")
            return
        for s in got:
            self.project.update(s.id, **changes)
        self._refresh_slices()
        self.statusBar().showMessage(f"改了 {len(got)} 条的参数（它们会变成「已过时」）")

    def batch_rename(self) -> None:
        """批量重命名。作用域 + 模板/查找替换 + 预览 + 冲突拦截,一样都不能少——
        原来那个"把全部切片改成 前缀_1..N"没有作用域也没有预览,手滑一次全工程的名字全废。"""
        if not self.project.slices:
            QMessageBox.information(self, "批量重命名", "工程里还没有切片。")
            return
        scopes = [
            ("选中的", self._selected_slices()),
            ("当前筛选的", list(self._visible)),
            ("全部", list(self.project.slices)),
        ]
        exported = {
            s.id for s in self.project.slices
            if self.ledger.get(s.id) is not None and self.status_of(s).state != ldg.STATE_NEVER
        }
        dlg = RenameDialog(
            self, scopes, all_slices=list(self.project.slices),
            out_dir=self._out_dir(), exported_ids=exported,
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        plan = dlg.plan()
        if not plan:
            return
        moved, blocked = 0, []
        for sl, new_name in plan:
            if dlg.wants_file_rename():
                ok, why = self._rename_artifact(sl, new_name)
                if ok:
                    moved += 1
                elif why:
                    blocked.append(f"{sl.name} → {new_name}：{why}")
            self.project.update(sl.id, name=new_name)
        self._save_ledger()
        self._refresh_slices()
        msg = f"改名 {len(plan)} 条"
        if moved:
            msg += f"，连带改名磁盘产物 {moved} 个（audio_config 里的引用要重挂）"
        self.statusBar().showMessage(msg)
        if blocked:
            QMessageBox.warning(
                self, "有几个磁盘产物没能改名",
                "切片名字已经改了，但这些文件没动（名字改了，产物还是老文件名）：\n\n"
                + "\n".join(blocked),
            )

    def _rename_artifact(self, sl: Slice, new_name: str) -> tuple[bool, str]:
        """把已导出的产物连同记账一起改名。返回 (改了没, 没改的原因)。

        **绝不覆盖**:目标已存在就放弃这一个并如实说——那多半是别的条目的产物。
        """
        rec = self.ledger.get(sl.id)
        if rec is None:
            return False, ""
        old = ldg.record_path(rec, self.repo_root, self._out_dir())
        new = old.with_name(f"{new_name}{ldg.OUT_EXT}")
        if not old.is_file():
            return False, ""
        if new.exists():
            return False, f"{new.name} 已经存在，没敢覆盖"
        try:
            ldg.rename_artifact(self.ledger, rec, old, new)
        except OSError as ex:
            return False, str(ex)
        return True, ""

    # ------------------------------------------------------------------ 试听

    def preview(self, processed: bool) -> None:
        s = self._selected_slice()
        if s is None:
            QMessageBox.information(self, "试听", "先在右边选一条切片。")
            return
        self._sync_settings()
        try:
            if processed:
                audio, rep = rnd.render_slice(
                    self.project, s, self.cache, noise=rnd.noise_sample_for(self.project, self.cache),
                )
                if audio is None:
                    QMessageBox.warning(self, "试听", rep.message or "渲染失败")
                    return
                self.preview_info.setText(
                    f"{rep.measured_lufs:+.1f} →{rep.applied_gain_db:+.1f}dB→ {rep.out_lufs:+.1f} LUFS"
                    f" · 真峰 {rep.out_true_peak_db:+.1f} dBTP"
                    + ("" if rep.hit_target else f" · 被真峰拦住，差 {rep.peak_limited_db:.1f} dB")
                )
            else:
                src = self.cache.get(s.source)
                audio = src.slice_seconds(s.start, s.end)
                self.preview_info.setText(f"原始 · {dsp.loudness_lufs(audio.samples, audio.rate):+.1f} LUFS")
        except (aio.AudioIOError, OSError, ValueError) as ex:
            QMessageBox.warning(self, "试听失败", str(ex))
            return
        # 每次新文件名:同名重写会命中媒体后端的解码缓存,听到的是上一版
        tmp = self._tmp_dir / f"preview_{uuid.uuid4().hex[:8]}.wav"
        aio.write(tmp, audio, bits=16)
        self._player.stop()
        self._player.setSource(QUrl.fromLocalFile(str(tmp)))
        self._player.play()

    # ------------------------------------------------------------------ 导出

    def _sync_settings(self) -> None:
        st = self.project.settings
        st.target_lufs = float(self.target_lufs.value())
        st.true_peak_ceiling_db = float(self.ceiling.value())
        st.denoise_reduction_db = float(self.denoise_db.value())
        st.export_mono = self.mono.isChecked()
        st.export_bits = int(self.bits.currentText())
        st.export_dir = self.export_dir.text().strip()
        st.split_threshold_db = float(self.split_thr.value())
        st.split_min_silence_s = float(self.split_gap.value())

    def _load_settings_into_ui(self) -> None:
        st = self.project.settings
        self.target_lufs.setValue(st.target_lufs)
        self.ceiling.setValue(st.true_peak_ceiling_db)
        self.denoise_db.setValue(st.denoise_reduction_db)
        self.mono.setChecked(st.export_mono)
        self.bits.setCurrentText(str(st.export_bits))
        self.export_dir.setText(st.export_dir)
        self.split_thr.setValue(st.split_threshold_db)
        self.split_gap.setValue(st.split_min_silence_s)
        self.noise_label.setText(
            f"{Path(st.noise_source).name} {st.noise_start:.2f}–{st.noise_end:.2f}s"
            if st.has_noise_sample else "未设置"
        )

    def pick_export_dir(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "选择导出目录", str(self.repo_root))
        if not d:
            return
        try:
            rel = Path(d).resolve().relative_to(self.repo_root.resolve())
            self.export_dir.setText(str(rel).replace("\\", "/"))
        except ValueError:
            self.export_dir.setText(d)

    def _scope_targets(self, scope: str) -> tuple[list[Slice], list[Slice]]:
        """(要导的, 其中"来历不明"需要点头的)。

        **不可导的一律不进来**:没勾「产」的、起止无效的、源不在本机的——
        把它们塞进导出集只会换来一串失败行。
        """
        if scope == SCOPE_SELECTED:
            pool = self._selected_slices()
        elif scope == SCOPE_FILTERED:
            pool = list(self._visible)
        else:
            pool = list(self.project.slices)
        usable, foreign = [], []
        for s in pool:
            st = self.status_of(s)
            if st.state in (ldg.STATE_EXCLUDED, ldg.STATE_INVALID, ldg.STATE_NO_SOURCE):
                continue
            if scope == SCOPE_NEEDED and not st.needs_export:
                continue
            if st.state == ldg.STATE_FOREIGN:
                foreign.append(s)
            usable.append(s)
        return usable, foreign

    def _update_export_button(self) -> None:
        if not hasattr(self, "btn_export"):
            return
        scope = self.export_scope.currentText()
        targets, _ = self._scope_targets(scope)
        self.btn_export.setEnabled(bool(targets))
        self.btn_export.setText(f"导出 {len(targets)} 条" if targets else "没有要导的")
        self.btn_export.setToolTip(
            "、".join(s.name for s in targets[:12]) + ("…" if len(targets) > 12 else "")
        )

    def export_all(self) -> None:
        self._recompute_status()
        problems = self.project.problems()
        if problems:
            QMessageBox.warning(self, "先修好这些再导", "\n".join(problems))
            return
        scope = self.export_scope.currentText()
        todo, foreign = self._scope_targets(scope)
        if not todo:
            n_foreign = sum(
                1 for s in self.project.slices
                if self.status_of(s).state == ldg.STATE_FOREIGN
            )
            extra = (
                f"\n\n另外有 {n_foreign} 条是「来历不明」（盘上有同名文件、但本工程没有它的记账）。"
                f"\n它们不会自动被覆盖：确认那批就是当前参数的产物就去「产物 → 按现状认账」，"
                f"\n要重导就把范围切到「全部」或选中它们。"
                if n_foreign else ""
            )
            QMessageBox.information(
                self, "导出",
                "这个范围里没有要导的。\n"
                "（「需要更新的」为空 = 盘上的产物已经是当前参数渲的，那是好事）" + extra,
            )
            return
        if foreign:
            names = "\n".join(f"· {s.name}.wav" for s in foreign[:12])
            more = f"\n…共 {len(foreign)} 个" if len(foreign) > 12 else ""
            r = QMessageBox.question(
                self, "有几个同名文件不是本工程导的",
                f"导出目录里已经有这些同名文件，但本工程没有它们的记账：\n\n{names}{more}\n\n"
                f"继续就会**覆盖**它们。要是拿不准，先取消，去「产物 → 按现状认账」认下来。",
                QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            if r != QMessageBox.StandardButton.Ok:
                todo = [s for s in todo if s not in foreign]
                if not todo:
                    return

        out_dir = self._out_dir()
        dlg = QProgressDialog("正在导出…", "取消", 0, len(todo), self)
        dlg.setWindowModality(Qt.WindowModality.WindowModal)
        dlg.setMinimumDuration(0)

        def progress(i: int, total: int, name: str) -> bool:
            dlg.setValue(i)
            if name:
                dlg.setLabelText(f"{name}（{i + 1}/{total}）")
            # **真的读这个取消**：原来那个取消按钮是画上去的，点了没人管
            return not dlg.wasCanceled()

        reports = rnd.export_project(
            self.project, self.lib, out_dir,
            targets=todo, overwrite=True, progress=progress,
            ledger=self.ledger, sha_cache=self.sha_cache,
            out_dir_setting=self.project.settings.export_dir,
        )
        dlg.close()
        self._save_ledger()
        self._refresh_slices()

        lines = [f"导出到 {out_dir}（范围：{scope}）", ""]
        for r in reports:
            if r.cancelled:
                continue
            if r.skipped:
                lines.append(f"跳过  {r.name}：{r.message}")
            elif not r.ok:
                lines.append(f"失败  {r.name}：{r.message}")
            else:
                tail = "" if r.hit_target else f"（被真峰拦住，差 {r.peak_limited_db:.1f} dB）"
                lines.append(
                    f"成功  {r.name}  {r.seconds:.2f}s  "
                    f"{r.measured_lufs:+.1f} →{r.applied_gain_db:+.1f}dB→ {r.out_lufs:+.1f} LUFS{tail}"
                )
        n_cancelled = sum(1 for r in reports if r.cancelled)
        if n_cancelled:
            lines.append(f"（你按了取消，还有 {n_cancelled} 条没轮到；已导出的那些留着）")
        lines += ["", rnd.summarize(reports)]
        self.report.setPlainText("\n".join(lines))
        self.statusBar().showMessage(rnd.summarize(reports))

    # ------------------------------------------------------------------ 工程

    # ------------------------------------------------------- 不丢东西（三件套）

    def _project_json(self) -> str:
        """当前工程的规范化文本。脏态判定**按内容比对**,不靠"每处改动记得调 mark_dirty"——
        切片改名/拖切点/改参数散在十来个地方,漏登记一处就是"没提示就没了"。"""
        self._sync_settings()
        return json.dumps(self.project.to_json(), ensure_ascii=False, sort_keys=True)

    def _mark_saved(self) -> None:
        self._saved_json = self._project_json()

    def is_dirty(self) -> bool:
        return self._project_json() != self._saved_json

    def _autosave_path(self) -> Path:
        d = projects_dir(self.state_dir) / ".autosave"
        name = self.project_path.stem if self.project_path else "未命名"
        return d / f"{name}.json"

    def _autosave(self) -> None:
        """定时自动存盘到 .autosave/。**不动工程本体**——自动存进去等于替用户做决定,
        他可能正想放弃这一版。崩溃/断电后由启动时的恢复提示来接。"""
        try:
            if not self.project.slices or not self.is_dirty():
                return
            self.project.save(self._autosave_path())
        except (OSError, ValueError):
            pass                      # 自动存盘失败绝不能打断正在干活的人

    def _ui_state_path(self) -> Path:
        return self.state_dir / "ui_state.json"

    def _remember_last_project(self) -> None:
        try:
            self._ui_state_path().write_text(
                json.dumps({"last_project": str(self.project_path or "")}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass

    def load_last_project(self) -> bool:
        """静默载回上次那个工程（不弹任何框）。返回是否真的载到了。"""
        try:
            last = str(json.loads(
                self._ui_state_path().read_text(encoding="utf-8"),
            ).get("last_project") or "")
        except (OSError, ValueError):
            return False
        if not last or not Path(last).is_file():
            return False
        try:
            self.project = Project.load(Path(last))
        except ValueError:
            return False
        self.project_path = Path(last)
        self.ledger = ldg.Ledger.load(ldg.ledger_path_for(self.project_path))
        self._load_settings_into_ui()
        self._rebuild_regions()
        self._refresh_slices()
        self._mark_saved()
        return True

    def pending_recovery(self) -> Path | None:
        """有没有比工程文件更新的自动存盘（= 上次没存就退出/崩了）。"""
        auto = self._autosave_path()
        if not auto.is_file():
            return None
        if self.project_path is None or not self.project_path.is_file():
            return auto
        return auto if auto.stat().st_mtime > self.project_path.stat().st_mtime else None

    def restore_session(self) -> None:
        """入口在 show() 之后调：载回上次工程，若有更新的自动存盘则问一句。

        **不在构造函数里做**：那会在离屏测试中弹出永不返回的模态框（踩过一次，
        整个测试套挂死 10 分钟）。恢复是一次显式的用户可见动作，不是构造副作用。
        """
        self.load_last_project()
        self.rescan_status()          # 顺带把"有没有产物还没认账"这件事说出来
        auto = self.pending_recovery()
        if auto is None:
            return
        r = QMessageBox.question(
            self, "发现自动存盘",
            f"上次退出时还有没保存的改动，自动存盘在：\n{auto}\n\n"
            f"要恢复它吗？（选「否」则用工程文件里的版本；自动存盘不会被删）",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        try:
            self.project = Project.load(auto)
        except ValueError as ex:
            QMessageBox.warning(self, "恢复失败", str(ex))
            return
        self._load_settings_into_ui()
        self._rebuild_regions()
        self._refresh_slices()
        self.statusBar().showMessage("已从自动存盘恢复——记得存一次（Ctrl+S）")

    def closeEvent(self, event) -> None:                      # noqa: N802 - Qt 命名
        """关窗前确认。**没存的切片是人一刀一刀拖出来的**,静默丢掉不可接受。"""
        if not self.is_dirty():
            self._remember_last_project()
            event.accept()
            return
        r = QMessageBox.question(
            self, "还有没保存的切片",
            f"工程「{self.project.name}」有未保存的改动（{len(self.project.slices)} 个切片）。\n要保存吗？",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if r == QMessageBox.StandardButton.Cancel:
            event.ignore()
            return
        if r == QMessageBox.StandardButton.Save:
            self.save_project()
            if self.is_dirty():          # 另存对话框被取消：别把人的东西关掉
                event.ignore()
                return
        self._remember_last_project()
        event.accept()

    def new_project(self) -> None:
        self.project = Project()
        self.project_path = None
        self.ledger = ldg.Ledger()          # 记账跟着工程走：新工程 = 一笔账都没有
        self.sha_cache.clear()
        self._load_settings_into_ui()
        self._rebuild_regions()
        self._refresh_slices()
        self._mark_saved()

    def open_project(self) -> None:
        d = projects_dir(TOOL_ROOT)
        d.mkdir(parents=True, exist_ok=True)
        f, _ = QFileDialog.getOpenFileName(self, "打开工程", str(d), "工程 (*.json)")
        if not f:
            return
        try:
            self.project = Project.load(Path(f))
        except ValueError as ex:
            QMessageBox.warning(self, "打开失败", str(ex))
            return
        self.project_path = Path(f)
        self.ledger = ldg.Ledger.load(ldg.ledger_path_for(self.project_path))
        self._load_settings_into_ui()
        self._rebuild_regions()
        self._refresh_slices()
        self._mark_saved()
        self._remember_last_project()
        self.statusBar().showMessage(f"已打开 {self.project.name}")

    def save_project(self) -> None:
        if self.project_path is None:
            self.save_project_as()
            return
        self._sync_settings()
        self.project.save(self.project_path)
        if len(self.ledger):
            # 记账跟着工程落地：工程第一次「另存为」之前它只在内存里。
            # 一笔账都没有就别在旁边留个空文件
            self.ledger.dirty = True
            self._save_ledger()
        self._mark_saved()
        self._remember_last_project()
        # 存过之后自动存盘就没用了，清掉免得下次启动误报"有更新的自动存盘"
        self._autosave_path().unlink(missing_ok=True)
        self.statusBar().showMessage(f"已保存 {self.project_path.name}")

    def save_project_as(self) -> None:
        d = projects_dir(TOOL_ROOT)
        d.mkdir(parents=True, exist_ok=True)
        f, _ = QFileDialog.getSaveFileName(self, "保存工程", str(d / f"{self.project.name}.json"), "工程 (*.json)")
        if not f:
            return
        self.project_path = Path(f)
        self.project.name = self.project_path.stem
        self.save_project()
