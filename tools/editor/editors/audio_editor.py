"""音频配置编辑器（audio_config.json 的各频道 + systemSfx）。

频道页签由 audio_library.AUDIO_CHANNELS 驱动，本文件不另列清单——
两处各写一份的结果是"配置里有、编辑器里看不见"，而且没有任何提示。

2026-08-10 重做。旧版的问题不是缺功能，是**挑不动音**：一行一个只读长路径框加三个
按钮，横向全被吃掉；看不见时长、看不见文件还在不在、看不见有没有人在用；试听是一个
裸 ▶，停不下来也听不了后半段；`volume`（运行时 `AudioEntry` 明确支持）在界面上根本
不存在，只能靠「未知键透传」苟活；改 id 是裸文本框，改完静默打断所有引用它的地方。

现在：一行 = id / 时长 / 文件 / volume / 引用 / 状态，全是轻量 item（127 行不再堆
四百个控件），底部一条共用走带（可暂停、可拖、可循环、可调音量），改名删除先查引用
再动手，外加「扫描未登记文件」把磁盘上躺着没登记的音频一次性收进来。
"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMenu,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .. import theme
from ..project_model import ProjectModel
from ..shared import audio_library as lib
from ..shared.audio_preview_selector import AudioIdPreviewSelector
from ..shared.audio_transport import AudioTransportBar
from ..shared.dialog_geometry import remember_dialog_geometry
from ..shared.id_ref_selector import IdRefSelector
from ..shared.list_affordances import make_table_search_box
from ..shared.numeric_roundtrip import preserve_numeric_repr
from ..shared.project_paths import DIR_KIND_RUNTIME_AUDIO

# 列序：id 必须留在第 0 列——全局搜索的 select_by_id 与既有测试都按 item(r, 0) 找它。
_COL_ID = 0
_COL_DURATION = 1
_COL_FILE = 2
_COL_VOLUME = 3
_COL_REFS = 4
_COL_STATUS = 5
_COLUMN_LABELS = ["id", "时长", "文件", "volume", "引用", "状态"]

#: 频道页签的显示名（键必须覆盖 audio_library.AUDIO_CHANNELS，缺了会退化成大写英文）
_CHANNEL_LABELS = {"bgm": "BGM", "ambient": "Ambient", "sfx": "SFX", "voice": "配音"}

#: 行的 src 挂在 id 单元格上（「文件」列只显示文件名，长路径进 tooltip）。
_SRC_ROLE = Qt.ItemDataRole.UserRole
#: volume 单元格上一次的合法文本，用于输入非法时回滚（绝不把用户原值改成 0）。
_LAST_GOOD_ROLE = Qt.ItemDataRole.UserRole + 1

_AUDIO_FILE_FILTER = "音频 (*.wav *.ogg *.mp3 *.m4a *.flac *.aif *.aiff);;所有文件 (*.*)"


def audio_src_to_local_file(model: ProjectModel, src: str) -> Path | None:
    """把音频 ``src`` 解析为本地存在文件（迁移后音频只允许落在 runtime 树下）。"""
    return lib.src_to_local_file(model, src)


def _disk_path_to_runtime_url(model: ProjectModel, path: Path) -> str | None:
    """音频选择器：仅接受 ``public/resources/runtime`` 下的文件。"""
    if model.project_path is None:
        return None
    return model.paths.disk_to_runtime_url(path)


class _UnregisteredFilesDialog(QDialog):
    """列出 runtime/audio 下没被任何频道登记的音频，勾选后一次性建条目。"""

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        files: list[Path],
        taken_ids: set[str],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("扫描未登记的音频文件")
        self.resize(760, 480)
        self._model = model
        self._channel = channel
        self._rows: list[tuple[Path, str]] = []
        self._rejected: list[tuple[str, str]] = []

        root = QVBoxLayout(self)
        head = QLabel(
            f"以下文件在 public/resources/runtime/audio 下，但没有任何 audio_config 条目"
            f"指向它们。勾选要登记进 <b>{channel}</b> 的，确定后会加到表里"
            f"（还需按 Apply 才写进模型）。",
            self,
        )
        head.setWordWrap(True)
        root.addWidget(head)

        self._table = QTableWidget(len(files), 2, self)
        self._table.setHorizontalHeaderLabels(["登记为 id", "文件"])
        self._table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.Interactive,
        )
        self._table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch,
        )
        self._table.setColumnWidth(0, 280)
        # 起名时避开**所有频道**已有的 id：跨频道同名是 validate-data 的一条 warning
        # （各区独立查表不回落，同名两条极容易改错一边），没必要现建现犯。
        used = set(taken_ids)
        for ch in lib.AUDIO_CHANNELS:
            used |= set(lib.channel_dict(model, ch))
        for i, path in enumerate(files):
            suggested = lib.suggest_audio_id(path, used)
            used.add(suggested)
            id_item = QTableWidgetItem(suggested)
            id_item.setFlags(id_item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            id_item.setCheckState(Qt.CheckState.Unchecked)
            self._table.setItem(i, 0, id_item)
            rel = _disk_path_to_runtime_url(model, path) or str(path)
            file_item = QTableWidgetItem(rel)
            file_item.setFlags(file_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            file_item.setToolTip(str(path))
            self._table.setItem(i, 1, file_item)
            self._rows.append((path, rel))
        root.addWidget(self._table, 1)

        btn_row = QHBoxLayout()
        all_btn = QPushButton("全选", self)
        all_btn.clicked.connect(lambda: self._set_all(True))
        none_btn = QPushButton("全不选", self)
        none_btn.clicked.connect(lambda: self._set_all(False))
        btn_row.addWidget(all_btn)
        btn_row.addWidget(none_btn)
        btn_row.addStretch(1)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        btn_row.addWidget(buttons)
        root.addLayout(btn_row)
        remember_dialog_geometry(self, "audio_unregistered_scan")

    def _set_all(self, on: bool) -> None:
        state = Qt.CheckState.Checked if on else Qt.CheckState.Unchecked
        for r in range(self._table.rowCount()):
            item = self._table.item(r, 0)
            if item is not None:
                item.setCheckState(state)

    def chosen(self) -> list[tuple[str, str]]:
        """返回 ``[(audio_id, src_url), …]``；id 留空的行视为不登记。

        id 这一格可以手改，改坏了**不放行**——理由挂在 :meth:`rejected` 由调用方摆出来。
        静默丢掉更糟：用户以为登记好了，等到游戏里没声才发现。
        """
        out: list[tuple[str, str]] = []
        self._rejected = []
        for r, (_path, rel) in enumerate(self._rows):
            item = self._table.item(r, 0)
            if item is None or item.checkState() != Qt.CheckState.Checked:
                continue
            aid = item.text().strip()
            if not aid:
                continue
            problem = lib.audio_id_problem(aid)
            if problem:
                self._rejected.append((aid, problem))
                continue
            out.append((aid, rel))
        return out

    def rejected(self) -> list[tuple[str, str]]:
        """上一次 :meth:`chosen` 里被挡下的 ``[(id, 原因), …]``。"""
        return list(self._rejected)


class _AudioChannelTab(QWidget):
    """各频道共用的表格页（bgm / ambient / sfx / voice 通用，无频道特化逻辑）。"""

    applied = Signal()  # Apply 后发出（System SFX 子页据此刷新 sfx id 候选）

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        cache: lib.AudioMetaCache | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._channel = channel
        self._cache = cache if cache is not None else lib.AudioMetaCache(self)
        self._ref_counts: dict[str, int] = {}
        self._guard_item_changed = False

        lay = QVBoxLayout(self)

        self._table = QTableWidget(0, len(_COLUMN_LABELS))
        self._table.setHorizontalHeaderLabels(_COLUMN_LABELS)
        header = self._table.horizontalHeader()
        header.setSectionResizeMode(_COL_ID, QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(_COL_DURATION, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(_COL_FILE, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(_COL_VOLUME, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(_COL_REFS, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(_COL_STATUS, QHeaderView.ResizeMode.ResizeToContents)
        self._table.setColumnWidth(_COL_ID, 260)
        # 行高压到 24：这一页常态是一百多行，多露几行比每行留白值钱
        self._table.verticalHeader().setDefaultSectionSize(24)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setAlternatingRowColors(True)
        self._table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._table.customContextMenuRequested.connect(self._show_table_menu)
        self._table.installEventFilter(self)
        self._table.itemChanged.connect(self._on_item_changed)
        self._table.itemDoubleClicked.connect(self._on_double_click)
        self._table.currentCellChanged.connect(self._on_current_row_changed)

        self._search = make_table_search_box(
            self._table,
            columns=(_COL_ID, _COL_FILE),
            tooltip="按音频 id 或文件名过滤下方行（仅隐藏不匹配项，不改动数据）。",
        )
        lay.addWidget(self._search)
        lay.addWidget(self._table, 1)

        # ---- 走带（一条，全表共用）
        transport_row = QHBoxLayout()
        self._auto = QCheckBox("选中即试听", self)
        self._auto.setToolTip(
            "选中一行就自动播放。默认关：这一页主要用来改 id/文件/音量，"
            "点行就出声会打断编辑；纯挑音时打开更顺手（双击行、按空格也能听）。",
        )
        transport_row.addWidget(self._auto)
        self._transport = AudioTransportBar(self)
        transport_row.addWidget(self._transport, 1)
        lay.addLayout(transport_row)

        # ---- 工具条
        btns = QHBoxLayout()
        for text, tip, slot in (
            ("+ 条目", "新增一条音频登记（先起 id，再选文件）", self._add),
            ("- 条目", "删除当前行（Delete 键 / 右键菜单亦可）；删前会先查引用", self._delete),
            ("重命名 id…", "改 id 前先查全工程引用，避免静默打断引用它的地方", self._rename),
            ("设置文件…", "为当前行选择音频文件（双击「文件」格同效）", self._browse_current),
            ("扫描未登记文件…", "列出 runtime/audio 下还没被登记的音频，批量建条目", self._scan_unregistered),
            ("统计引用", "重新扫描内容 JSON 与 src 源码，更新「引用」列", self._recount_refs),
        ):
            btn = QPushButton(text)
            btn.setToolTip(tip)
            btn.clicked.connect(slot)
            btns.addWidget(btn)
        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("把本页表格提交到模型（Save All 也会自动提交）")
        apply_btn.clicked.connect(self._apply)
        btns.addWidget(apply_btn)
        btns.addStretch()
        lay.addLayout(btns)

        self._note = QLabel("", self)
        self._note.setStyleSheet(theme.semantic_text_css("muted"))
        self._note.setWordWrap(True)
        lay.addWidget(self._note)

        self._cache.updated.connect(self._refresh_durations)
        self._refresh()

    # ------------------------------------------------------------- 铺行/刷新
    def set_reference_counts(self, counts: dict[str, int]) -> None:
        self._ref_counts = counts
        self._refresh_ref_column()

    def _refresh(self) -> None:
        """从模型重铺全表（也是 Discard 的回滚路径）。"""
        entries = lib.channel_dict(self._model, self._channel)
        self._guard_item_changed = True
        try:
            self._table.setRowCount(len(entries))
            for i, (aid, obj) in enumerate(entries.items()):
                self._fill_row(i, str(aid), lib.entry_src(obj), lib.entry_volume(obj))
        finally:
            self._guard_item_changed = False
        self._cache.prefetch(
            lib.src_to_local_file(self._model, lib.entry_src(obj))
            for obj in entries.values()
        )
        self._refresh_ref_column()
        # 重新套用搜索过滤，使 setRowHidden 与新内容一致
        self._search.textChanged.emit(self._search.text())

    def add_row(self, aid: str, src: str = "", volume: float | None = None) -> int:
        """在表尾追加一行（不写模型，等 Apply）。批量登记与测试的统一入口。"""
        row = self._table.rowCount()
        self._guard_item_changed = True
        try:
            self._table.insertRow(row)
            self._fill_row(row, aid, src, volume)
        finally:
            self._guard_item_changed = False
        self._search.textChanged.emit(self._search.text())
        return row

    def _fill_row(self, row: int, aid: str, src: str, volume: float | None) -> None:
        id_item = QTableWidgetItem(aid)
        id_item.setData(_SRC_ROLE, src)
        id_item.setFlags(id_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
        id_item.setToolTip("双击改名（会先查引用）")
        self._table.setItem(row, _COL_ID, id_item)

        vol_text = "" if volume is None else _format_volume(volume)
        vol_item = QTableWidgetItem(vol_text)
        vol_item.setData(_LAST_GOOD_ROLE, vol_text)
        vol_item.setToolTip("0～1 的播放音量；留空=默认（1.0）。双击可编辑。")
        self._table.setItem(row, _COL_VOLUME, vol_item)

        for col in (_COL_DURATION, _COL_FILE, _COL_REFS, _COL_STATUS):
            item = QTableWidgetItem("")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self._table.setItem(row, col, item)
        self._table.item(row, _COL_FILE).setToolTip("双击选择音频文件")
        self._refresh_row_meta(row)

    def _refresh_row_meta(self, row: int) -> None:
        """按当前 src 重算「时长/文件/状态」三列（不碰 id / volume / 引用）。"""
        id_item = self._table.item(row, _COL_ID)
        if id_item is None:
            return
        src = str(id_item.data(_SRC_ROLE) or "")
        path = lib.src_to_local_file(self._model, src)
        file_item = self._table.item(row, _COL_FILE)
        dur_item = self._table.item(row, _COL_DURATION)
        status_item = self._table.item(row, _COL_STATUS)
        if file_item is None or dur_item is None or status_item is None:
            return
        file_item.setText(path.name if path is not None else (src or ""))
        file_item.setToolTip(src or "尚未选择文件（双击此格选择）")
        dur_item.setText(lib.format_duration(self._cache.duration(path)))
        if path is None:
            status_item.setText("缺文件" if src else "缺 src")
            status_item.setToolTip(
                f"src={src or '(空)'} 解析不到 public/resources/runtime 下的文件；"
                "运行时会静音。",
            )
            status_item.setForeground(_brush("error"))
        else:
            status_item.setText("✓")
            status_item.setToolTip(str(path))
            status_item.setForeground(_brush("ok"))

    def _refresh_durations(self) -> None:
        self._guard_item_changed = True
        try:
            for row in range(self._table.rowCount()):
                id_item = self._table.item(row, _COL_ID)
                dur_item = self._table.item(row, _COL_DURATION)
                if id_item is None or dur_item is None:
                    continue
                path = lib.src_to_local_file(self._model, str(id_item.data(_SRC_ROLE) or ""))
                dur_item.setText(lib.format_duration(self._cache.duration(path)))
        finally:
            self._guard_item_changed = False

    def _refresh_ref_column(self) -> None:
        self._guard_item_changed = True
        try:
            for row in range(self._table.rowCount()):
                id_item = self._table.item(row, _COL_ID)
                ref_item = self._table.item(row, _COL_REFS)
                if id_item is None or ref_item is None:
                    continue
                if not self._ref_counts:
                    ref_item.setText("")
                    ref_item.setToolTip("按「统计引用」扫描内容 JSON")
                    continue
                n = self._ref_counts.get(id_item.text().strip(), 0)
                ref_item.setText(str(n))
                ref_item.setToolTip(
                    "这个 id 在内容 JSON（data / scenes / dialogues）里当值出现、"
                    "以及在运行时 TS 源码里作为字符串常量出现的总次数。\n"
                    "只看磁盘文件，编辑器里尚未保存的改动不算；"
                    "文本级统计，权威引用图请用「查引用(JSON 语言)」。",
                )
                ref_item.setForeground(_brush("muted" if n else "faint"))
        finally:
            self._guard_item_changed = False

    def _recount_refs(self) -> None:
        self.set_reference_counts(lib.build_reference_counts(self._model))
        self._note.setText(
            "引用列已按磁盘上的内容 JSON + src 源码重新统计（编辑器里未保存的改动不计入）。",
        )

    # ------------------------------------------------------------------ 试听
    def _row_path(self, row: int) -> Path | None:
        id_item = self._table.item(row, _COL_ID)
        if id_item is None:
            return None
        return lib.src_to_local_file(self._model, str(id_item.data(_SRC_ROLE) or ""))

    def _on_current_row_changed(self, row: int, _col: int, prev_row: int, _pc: int) -> None:
        if row < 0 or row == prev_row:
            return
        self._transport.play_file(self._row_path(row), autoplay=self._auto.isChecked())

    def _play_current(self) -> None:
        row = self._table.currentRow()
        if row < 0:
            return
        self._transport.play_file(self._row_path(row), autoplay=True)

    def _stop_preview(self) -> None:
        self._transport.stop()

    # --------------------------------------------------------------- 行编辑
    def _on_item_changed(self, item: QTableWidgetItem) -> None:
        """只有 volume 列可编辑；非法输入回滚到上一次合法值并说明原因。"""
        if self._guard_item_changed or item.column() != _COL_VOLUME:
            return
        text = item.text().strip()
        if text == "":
            item.setData(_LAST_GOOD_ROLE, "")
            self._note.setText("")
            return
        try:
            value = float(text)
        except ValueError:
            value = None
        if value is None or not (0.0 <= value <= 1.0):
            last = str(item.data(_LAST_GOOD_ROLE) or "")
            self._guard_item_changed = True
            try:
                item.setText(last)
            finally:
                self._guard_item_changed = False
            self._note.setText(
                f"volume 只接受 0～1 的数（或留空=默认）；「{text}」已退回原值。",
            )
            return
        item.setData(_LAST_GOOD_ROLE, text)
        self._note.setText("")

    def _on_double_click(self, item: QTableWidgetItem) -> None:
        if item.column() == _COL_FILE:
            self._browse_row(item.row())
        elif item.column() == _COL_ID:
            self._rename_row(item.row())
        elif item.column() in (_COL_DURATION, _COL_STATUS):
            self._play_current()

    def _browse_current(self) -> None:
        row = self._table.currentRow()
        if row < 0:
            QMessageBox.information(self, "设置文件", "先选中一行。")
            return
        self._browse_row(row)

    def _browse_row(self, row: int) -> None:
        id_item = self._table.item(row, _COL_ID)
        if id_item is None:
            return
        start = self._model.paths.default_dir(DIR_KIND_RUNTIME_AUDIO)
        try:
            start.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        path_str, _ = QFileDialog.getOpenFileName(
            self, "选择音频文件", str(start), _AUDIO_FILE_FILTER,
        )
        if not path_str:
            return
        url = _disk_path_to_runtime_url(self._model, Path(path_str))
        if not url:
            QMessageBox.warning(
                self,
                "音频路径",
                "迁移后音频必须放在 public/resources/runtime/audio 下，"
                "请把文件移动过来再选择。",
            )
            return
        self._set_row_src(row, url)

    def _set_row_src(self, row: int, src: str) -> None:
        id_item = self._table.item(row, _COL_ID)
        if id_item is None:
            return
        self._guard_item_changed = True
        try:
            id_item.setData(_SRC_ROLE, src)
            self._refresh_row_meta(row)
        finally:
            self._guard_item_changed = False
        self._cache.prefetch([lib.src_to_local_file(self._model, src)])

    def _clear_row_src(self) -> None:
        row = self._table.currentRow()
        if row >= 0:
            self._set_row_src(row, "")

    def _reject_bad_id(self, title: str, aid: str) -> bool:
        """id 不合法就弹窗说明并返回 True（调用方直接 return）。"""
        problem = lib.audio_id_problem(aid)
        if problem is None:
            return False
        QMessageBox.warning(
            self, title,
            f"{problem}\n\n直接照文件名起最省事——中文可以，空格、引号、斜杠不行。",
        )
        return True

    def _add(self) -> None:
        taken = self._table_ids()
        aid, ok = QInputDialog.getText(
            self, "新增音频条目", f"新条目的 id（audio_config.{self._channel} 内唯一）：",
        )
        if not ok:
            return
        aid = (aid or "").strip()
        if not aid:
            return
        if self._reject_bad_id("新增音频条目", aid):
            return
        if aid in taken:
            QMessageBox.warning(self, "新增音频条目", f"id「{aid}」在本频道已存在。")
            return
        row = self.add_row(aid)
        self._table.setCurrentCell(row, _COL_ID)
        self._browse_row(row)

    def _delete(self) -> None:
        row = self._table.currentRow()
        if row < 0:
            return
        id_item = self._table.item(row, _COL_ID)
        aid = id_item.text().strip() if id_item is not None else ""
        used = self._reference_count_for(aid)
        if used:
            answer = QMessageBox.question(
                self,
                "删除音频条目",
                f"「{aid}」在内容 JSON 里被当值用到 {used} 次。\n"
                "删掉它不会自动改那些地方，运行时会静音。仍要删除吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if answer != QMessageBox.StandardButton.Yes:
                return
        self._table.removeRow(row)

    def _rename(self) -> None:
        row = self._table.currentRow()
        if row < 0:
            QMessageBox.information(self, "重命名", "先选中一行。")
            return
        self._rename_row(row)

    def _rename_row(self, row: int) -> None:
        id_item = self._table.item(row, _COL_ID)
        if id_item is None:
            return
        old = id_item.text().strip()
        used = self._reference_count_for(old)
        prompt = f"把「{old}」改成："
        if used:
            prompt += (
                f"\n\n注意：这个 id 在内容 JSON 里被当值用到 {used} 次。"
                "\n改名**不会**自动改那些地方——改完请用「查引用(JSON 语言)」逐个跟。"
            )
        new, ok = QInputDialog.getText(self, "重命名音频 id", prompt, text=old)
        if not ok:
            return
        new = (new or "").strip()
        if not new or new == old:
            return
        if self._reject_bad_id("重命名音频 id", new):
            return
        if new in self._table_ids() - {old}:
            QMessageBox.warning(self, "重命名音频 id", f"id「{new}」在本频道已存在。")
            return
        self._guard_item_changed = True
        try:
            id_item.setText(new)
        finally:
            self._guard_item_changed = False
        self._refresh_ref_column()

    def _scan_unregistered(self) -> None:
        files = lib.scan_unregistered_files(self._model)
        # 表里已排上队但还没 Apply 的 src 也算「已登记」，免得重复建条目
        pending = {
            p
            for p in (self._row_path(r) for r in range(self._table.rowCount()))
            if p is not None
        }
        files = [f for f in files if f not in pending]
        if not files:
            QMessageBox.information(
                self, "扫描未登记的音频文件",
                "runtime/audio 下的音频都已经在 audio_config 里登记过了。",
            )
            return
        dialog = _UnregisteredFilesDialog(
            self._model, self._channel, files, self._table_ids(), self,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        chosen = dialog.chosen()
        skipped = [f"「{aid}」{why}" for aid, why in dialog.rejected()]
        if not chosen and not skipped:
            return
        taken = self._table_ids()
        added = 0
        for aid, src in chosen:
            if aid in taken:
                skipped.append(f"「{aid}」本频道已有同名条目")
                continue
            taken.add(aid)
            self.add_row(aid, src)
            added += 1
        note = f"已加入 {added} 条新登记，按 Apply 才写进模型。"
        if skipped:
            note += f"另有 {len(skipped)} 条没登记。"
            QMessageBox.warning(
                self, "扫描未登记的音频文件",
                "这些行没有登记：\n" + "\n".join(skipped),
            )
        self._note.setText(note)

    def _table_ids(self) -> set[str]:
        out: set[str] = set()
        for row in range(self._table.rowCount()):
            item = self._table.item(row, _COL_ID)
            if item is not None and item.text().strip():
                out.add(item.text().strip())
        return out

    def _reference_count_for(self, audio_id: str) -> int:
        if not audio_id:
            return 0
        if not self._ref_counts:
            self._ref_counts = lib.build_reference_counts(self._model)
            self._refresh_ref_column()
        return int(self._ref_counts.get(audio_id, 0))

    # --------------------------------------------------------------- 菜单/键
    def _show_table_menu(self, pos) -> None:
        if self._table.rowCount() == 0:
            return
        menu = QMenu(self._table)
        menu.addAction("试听此行", self._play_current)
        menu.addAction("停止", self._stop_preview)
        menu.addSeparator()
        menu.addAction("设置音频文件…", self._browse_current)
        menu.addAction("清除文件", self._clear_row_src)
        menu.addAction("重命名 id…", self._rename)
        menu.addSeparator()
        menu.addAction("删除此行", self._delete)
        menu.exec(self._table.viewport().mapToGlobal(pos))

    def eventFilter(self, obj, event):  # type: ignore[override]
        if (
            obj is self._table
            and isinstance(event, QKeyEvent)
            and event.type() == QKeyEvent.Type.KeyPress
        ):
            if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                self._delete()
                return True
            if event.key() == Qt.Key.Key_Space:
                self._play_current()
                return True
        return super().eventFilter(obj, event)

    # ------------------------------------------------------------ 提交/脏判
    def _build_channel(self) -> dict:
        """从表格构建本频道的 ``{id: entry}``（不写模型），供 _apply 与 _is_dirty 共用。"""
        old_ch = lib.channel_dict(self._model, self._channel)
        ch: dict = {}
        for row in range(self._table.rowCount()):
            id_item = self._table.item(row, _COL_ID)
            if id_item is None or not id_item.text().strip():
                continue
            aid = id_item.text().strip()
            src = str(id_item.data(_SRC_ROLE) or "").strip()
            # 保留同 id 原条目的未知键（未来字段），只更新本页真正管的 src / volume
            prev = old_ch.get(aid)
            entry = dict(prev) if isinstance(prev, dict) else {}
            entry["src"] = src
            vol_item = self._table.item(row, _COL_VOLUME)
            vol_text = vol_item.text().strip() if vol_item is not None else ""
            if vol_text == "":
                entry.pop("volume", None)
            else:
                try:
                    entry["volume"] = float(vol_text)
                except ValueError:
                    pass  # 非法文本已在录入时挡下；真漏进来也不摧毁原值
            # 未改动的数值按原始 JSON 表示回写（0.8 不得漂成 0.8000000001、1 不得漂成 1.0）
            preserve_numeric_repr(entry, prev if isinstance(prev, dict) else None)
            ch[aid] = entry
        return ch

    def _is_dirty(self) -> bool:
        ch = self._build_channel()
        old = self._model.audio_config.get(self._channel)
        if old is None:
            return bool(ch)  # 频道键本就缺失：只有真加了条目才算脏（避免打开即脏）
        return ch != (old if isinstance(old, dict) else {})

    def _apply(self) -> None:
        ch = self._build_channel()
        # 无实质变化不写不标脏：堵住「每次 Save All 重写 audio_config.json」
        if not self._is_dirty():
            return
        self._model.audio_config[self._channel] = ch
        self._model.mark_dirty("audio")
        self.applied.emit()


# 运行时实际会触发的 system 事件键。权威来源：src/systems/AudioManager.ts 中
# 所有 playSystemSfx('<key>') 调用。新增运行时事件时同步此表（下拉仍可编辑，
# 未在表内的旧键不会被丢弃）。
_SYSTEM_SFX_KEYS: list[str] = [
    "archiveUpdated", "coinGain", "coinSpend", "cutsceneEnd", "cutsceneStart",
    "dayEnd", "dayStart", "dialogueAdvance", "dialogueChoice", "dialogueEnd",
    "dialogueStart", "documentReveal", "encounterChoice", "encounterResult",
    "encounterStart", "hotspotInteract", "inventoryFull", "itemAcquired",
    "itemConsumed", "mapTravel", "minigameResult", "questAccepted",
    "questCompleted", "ruleAcquired", "ruleFragment", "ruleLayer",
    "ruleUseApply", "sceneTransition", "shopClose", "shopOpen", "uiCancel",
    "uiConfirm", "uiHover", "uiNotification", "uiPanelClose", "uiPanelOpen",
    "uiWarning", "zoneRuleAvailable", "zoneRuleUnavailable",
]


class _SystemSfxTab(QWidget):
    """系统事件 → sfx id 的映射表（sfx 列走可试听的弹窗选择器）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        lay = QVBoxLayout(self)

        self._table = QTableWidget(0, 2)
        self._table.setToolTip(
            "系统事件键 → SFX id。留空该事件即静音。sfx 列点开是可搜可试听的选择窗。")
        self._table.setHorizontalHeaderLabels(["system key", "sfx id"])
        self._table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._table.verticalHeader().setDefaultSectionSize(30)
        self._table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._table.customContextMenuRequested.connect(self._show_table_menu)
        self._table.installEventFilter(self)

        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索…")
        self._search.setClearButtonEnabled(True)
        self._search.setToolTip(
            "按 system key / sfx id 过滤下方行（仅隐藏不匹配项，不改动数据）。")
        self._search.textChanged.connect(self._filter_rows)
        lay.addWidget(self._search)
        lay.addWidget(self._table)

        btns = QHBoxLayout()
        add_btn = QPushButton("+ Mapping")
        add_btn.setToolTip("新增一条系统事件 → SFX id 映射")
        add_btn.clicked.connect(self._add)
        del_btn = QPushButton("- Mapping")
        del_btn.setToolTip("删除当前选中行（Delete 键 / 右键菜单亦可）")
        del_btn.clicked.connect(self._delete)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        btns.addWidget(add_btn)
        btns.addWidget(del_btn)
        btns.addWidget(apply_btn)
        btns.addStretch()
        lay.addLayout(btns)
        self._refresh()

    def _make_key_selector(self, initial_key: str) -> IdRefSelector:
        """system 事件键用可编辑下拉：候选取自运行时枚举（39 条，属短枚举），
        可编辑 + 孤儿前置，既不限制旧键也不静默丢弃既有数据。"""
        keys = list(_SYSTEM_SFX_KEYS)
        ik = (initial_key or "").strip()
        if ik and ik not in keys:
            keys = [ik] + keys
        sel = IdRefSelector(self, allow_empty=False, editable=True)
        sel.set_items(keys)
        sel.set_current(ik)
        return sel

    def _key_at(self, row: int) -> str:
        w = self._table.cellWidget(row, 0)
        if isinstance(w, IdRefSelector):
            return w.current_id().strip()
        it = self._table.item(row, 0)
        return it.text().strip() if it else ""

    def _make_sfx_selector(self, initial_id: str) -> AudioIdPreviewSelector:
        items = [(sid, sid) for sid in self._model.all_audio_ids("sfx")]
        if initial_id and all(x[0] != initial_id for x in items):
            items = [(initial_id, initial_id)] + items
        sel = AudioIdPreviewSelector(self._model, "sfx", self, allow_empty=True, editable=True)
        sel.set_items(items)
        sel.set_current(initial_id)
        sel.setToolTip("systemSfx 使用的 sfx id；点开可搜索试听，右侧 ▶ 直接听当前值。")
        return sel

    def _refresh(self) -> None:
        entries = self._model.audio_config.get("systemSfx", {})
        if not isinstance(entries, dict):
            entries = {}
        self._table.setRowCount(len(entries))
        for i, (key, sfx_id) in enumerate(entries.items()):
            self._table.setCellWidget(i, 0, self._make_key_selector(str(key)))
            self._table.setCellWidget(i, 1, self._make_sfx_selector(str(sfx_id or "")))
        # 重新套用搜索过滤，使 setRowHidden 与新内容一致
        self._filter_rows(self._search.text())

    def _filter_rows(self, text: str) -> None:
        """纯视图过滤：仅 setRowHidden 隐藏不匹配行（读 cell-widget 当前文本），不改数据。"""
        q = text.strip().lower()
        for r in range(self._table.rowCount()):
            if not q:
                self._table.setRowHidden(r, False)
                continue
            hit = False
            for c in (0, 1):
                w = self._table.cellWidget(r, c)
                cur = w.current_id() if w is not None else ""
                if q in (cur or "").lower():
                    hit = True
                    break
            self._table.setRowHidden(r, not hit)

    def _add(self) -> None:
        r = self._table.rowCount()
        self._table.insertRow(r)
        self._table.setCellWidget(r, 0, self._make_key_selector(""))
        self._table.setCellWidget(r, 1, self._make_sfx_selector(""))

    def _delete(self) -> None:
        r = self._table.currentRow()
        if r >= 0:
            self._table.removeRow(r)

    def _show_table_menu(self, pos) -> None:
        if self._table.rowCount() == 0:
            return
        menu = QMenu(self._table)
        menu.addAction("删除此行", self._delete)
        menu.exec(self._table.viewport().mapToGlobal(pos))

    def eventFilter(self, obj, event):  # type: ignore[override]
        if (
            obj is self._table
            and isinstance(event, QKeyEvent)
            and event.type() == QKeyEvent.Type.KeyPress
            and event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace)
        ):
            self._delete()
            return True
        return super().eventFilter(obj, event)

    def _build_mapping(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for i in range(self._table.rowCount()):
            key = self._key_at(i)
            sel = self._table.cellWidget(i, 1)
            sfx_id = (
                sel.current_id().strip()
                if isinstance(sel, (IdRefSelector, AudioIdPreviewSelector))
                else ""
            )
            if key:
                out[key] = sfx_id
        return out

    def _is_dirty(self) -> bool:
        out = self._build_mapping()
        old = self._model.audio_config.get("systemSfx")
        if old is None:
            return bool(out)  # systemSfx 键本就缺失：只有真加了映射才算脏（避免打开即脏）
        return out != old

    def refresh_sfx_choices(self) -> None:
        """SFX 子页新增 sfx id 后，刷新本页每行的候选（编辑器内自刷，不必重开工程）。
        保留各行当前选择（悬垂/未登记值仍前置保值）。"""
        items = [(sid, sid) for sid in self._model.all_audio_ids("sfx")]
        for r in range(self._table.rowCount()):
            sel = self._table.cellWidget(r, 1)
            if not isinstance(sel, AudioIdPreviewSelector):
                continue
            cur = sel.current_id()
            row_items = list(items)
            if cur and all(x[0] != cur for x in row_items):
                row_items = [(cur, cur)] + row_items
            sel.set_items(row_items)
            sel.set_current(cur)

    def _apply(self) -> None:
        out = self._build_mapping()
        # 无实质变化不写不标脏
        if not self._is_dirty():
            return
        self._model.audio_config["systemSfx"] = out
        self._model.mark_dirty("audio")


class AudioEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        lay = QVBoxLayout(self)
        tabs = QTabWidget()
        # 一份时长缓存三页共用：同一个文件在不同频道登记时只探一次。
        self._cache = lib.AudioMetaCache(self)

        # 保留子页引用，供 Save All 时统一提交（否则未点 Apply 的音频表编辑会被静默丢弃）。
        # 频道清单从 audio_library.AUDIO_CHANNELS 来，**不再在这里写死**：
        # voice 区加进配置后，这里漏加一行的后果是"数据在盘上、编辑器里看不见"，
        # 而且一声不吭（踩过一次）。加新频道只改那一处常量。
        self._sub_tabs = [
            _AudioChannelTab(model, ch, self._cache) for ch in lib.AUDIO_CHANNELS
        ] + [_SystemSfxTab(model)]

        for tab, ch in zip(self._sub_tabs, lib.AUDIO_CHANNELS):
            tabs.addTab(tab, _CHANNEL_LABELS.get(ch, ch.upper()))
        tabs.addTab(self._sub_tabs[-1], "System SFX")

        # SFX 子页 Apply 后，System SFX 子页的 sfx id 候选立即刷新（编辑器内自刷）。
        self.channel_tab("sfx").applied.connect(self.system_sfx_tab().refresh_sfx_choices)
        # 切页时停掉上一页的试听：换页还在响会让人以为是别的地方在出声。
        tabs.currentChanged.connect(self._on_tab_changed)

        self._tabs = tabs
        lay.addWidget(tabs)
        # 开面板即统计引用（~0.2s）。这一行掉了的后果是四个页的「引用」列全空，
        # 而且不报错——由 TestAudioColumnsPopulated 钉住。
        self.refresh_reference_counts()

    # 子页一律**按名取**，不按下标：加一个频道就会把后面的下标全顶偏，
    # 而顶偏之后调用方拿到的是"另一个页"——不报错，只是行为悄悄错了（加 voice 页时踩过）。
    def channel_tab(self, channel: str) -> "_AudioChannelTab":
        return self._sub_tabs[lib.AUDIO_CHANNELS.index(channel)]

    def system_sfx_tab(self) -> "_SystemSfxTab":
        return self._sub_tabs[-1]

    def refresh_reference_counts(self) -> None:
        """扫一遍内容 JSON + src 源码填「引用」列（实测 ~0.2s，开面板时直接做，不劳用户点）。"""
        counts = lib.build_reference_counts(self._model)
        for tab in self._sub_tabs:
            setter = getattr(tab, "set_reference_counts", None)
            if callable(setter):
                setter(counts)

    def _on_tab_changed(self, _index: int) -> None:
        for tab in self._sub_tabs:
            stop = getattr(tab, "_stop_preview", None)
            if callable(stop):
                stop()

    def select_by_id(self, audio_id: str, _scene_id: str = "") -> bool:
        """全局搜索/跳转落点：在四个音频子页的表格里按 id/键定位并切页选中。

        System SFX 子页第 0 列是 cellWidget(IdRefSelector)，table.item(r,0) 恒 None——
        必须走该页的 _key_at(r) 取键，否则匹配恒空、跳转静默失败还谎报已定位（审查 P2）。
        返回是否命中（导航诚实化：未命中报错不聚光）。"""
        target = (audio_id or "").strip()
        if not target:
            return False
        for idx, tab in enumerate(self._sub_tabs):
            table = getattr(tab, "_table", None)
            if table is None:
                continue
            key_at = getattr(tab, "_key_at", None)  # System SFX 用 cellWidget，走 _key_at
            for r in range(table.rowCount()):
                if callable(key_at):
                    cur = key_at(r)
                else:
                    it = table.item(r, 0)
                    cur = it.text().strip() if it is not None else ""
                if cur == target:
                    search = getattr(tab, "_search", None)
                    if search is not None and search.text():
                        search.clear()  # 目标行可能被子页过滤隐藏
                    self._tabs.setCurrentIndex(idx)
                    table.setCurrentCell(r, 0)
                    table.scrollToItem(table.item(r, 0) or table.currentItem())
                    return True
        return False

    def _is_dirty(self) -> bool:
        return any(tab._is_dirty() for tab in self._sub_tabs)

    def has_unapplied_edits(self) -> bool:
        """给外部同步逻辑问的：表格里有没有还没提交进模型的编辑。

        与 `ProjectModel._dirty` 不是一回事——表格编辑在点 Apply / Save All 之前
        根本不进脏桶，所以「模型不脏」并不代表「面板没东西」。
        """
        return self._is_dirty()

    def reload_from_model(self) -> None:
        """把四个子页的表格按模型重铺（外部工具改盘、模型被重读之后必须调）。

        这些表格是构造时的一次性快照，全类没有 showEvent / data_changed 订阅，
        所以模型换了它们不会自己跟。不跟的后果是实打实的：`flush_to_model` 会在
        下一次 Save All 里用陈旧表格覆盖刚同步进来的值，外部工具的成果凭空消失。

        调用方必须先确认 `has_unapplied_edits()` 为假——这里是无条件重铺，
        有未应用编辑时调它就是把用户的编辑丢掉。
        """
        for tab in self._sub_tabs:
            tab._refresh()
        self.refresh_reference_counts()

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        """Save All 钩子：提交各音频子页表格的未应用编辑。表驱动 _apply 无条件提交安全——
        只写当前表状态，未编辑写回等值数据，保存后清脏。"""
        for tab in self._sub_tabs:
            ap = getattr(tab, "_apply", None)
            if callable(ap):
                ap()
        return True

    def confirm_close(self, parent=None) -> bool:
        """关闭/切工程门控：有未应用编辑则 Save/Discard/Cancel（对齐 item/shop 口径）。
        Discard 按契约把各子页表格回滚到模型值（_refresh），避免关闭路径统一 flush 复活。"""
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "音频配置有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self.flush_to_model()
        else:
            for tab in self._sub_tabs:
                tab._refresh()  # 回滚 UI 到模型值，中和后续统一 flush
        return True


def _format_volume(value: float) -> str:
    """把 JSON 里的 volume 显示成人读得懂又能原样回写的文本（1 → ``1``，0.8 → ``0.8``）。"""
    if float(value).is_integer():
        return str(int(value))
    return f"{value:g}"


def _brush(kind: str):
    from PySide6.QtGui import QBrush, QColor

    return QBrush(QColor(theme.semantic_text_color(kind)))
