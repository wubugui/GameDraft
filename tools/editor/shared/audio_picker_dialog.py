"""音频选择弹窗：搜索 + 时长/文件/状态列 + 走带试听，**上下键即听**。

取代「127 项的巨型下拉」：那种下拉既搜不了、也听不了、还得先提交才知道选错，
挑一条音效要来回十几次。这里的判据是「不提交也能听」——
方向键换行即试听（可关），双击/回车才提交，取消不改任何值。

数据安全沿用引用选择器契约：当前值不在候选里时置顶保值成 ``[缺失]`` 行，
取消或未改选一律原值返回，绝不静默顶替。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMenu,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .. import theme
from ..project_model import ProjectModel
from . import audio_library as lib
from .audio_transport import AudioTransportBar
from .dialog_geometry import remember_dialog_geometry

_COL_ID = 0
_COL_DURATION = 1
_COL_FILE = 2
_COL_STATUS = 3

_VALUE_ROLE = Qt.ItemDataRole.UserRole
_SORT_ROLE = Qt.ItemDataRole.UserRole + 1

_CHANNEL_LABEL = {"bgm": "背景音乐", "ambient": "环境音", "sfx": "音效"}


class _AudioRowItem(QTreeWidgetItem):
    """时长列按秒数排序（按文本排会把 ``9.9s`` 排到 ``10.0s`` 后面）。"""

    def __lt__(self, other: QTreeWidgetItem) -> bool:  # noqa: D105
        col = self.treeWidget().sortColumn() if self.treeWidget() else _COL_ID
        if col == _COL_DURATION:
            mine = self.data(_COL_DURATION, _SORT_ROLE)
            theirs = other.data(_COL_DURATION, _SORT_ROLE)
            # 未探测出时长的排最后，不与 0 秒混淆
            mine = float(mine) if isinstance(mine, (int, float)) else float("inf")
            theirs = float(theirs) if isinstance(theirs, (int, float)) else float("inf")
            return mine < theirs
        return super().__lt__(other)


class AudioPickerDialog(QDialog):
    """选一个 audio_config id；``selected_value()`` 返回结果（空串 = 用户按了「清空」）。"""

    def __init__(
        self,
        model: ProjectModel,
        channel: str,
        rows: list[tuple[str, str]] | list[str],
        *,
        current: str = "",
        allow_empty: bool = True,
        parent: QWidget | None = None,
        cache: lib.AudioMetaCache | None = None,
        title: str = "",
        allow_manual_id: bool = False,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._channel = channel
        self._current = str(current or "").strip()
        self._selected = self._current
        self._cache = cache if cache is not None else lib.AudioMetaCache(self)
        self._owns_cache = cache is None
        self._pending_sound: str = ""

        label = _CHANNEL_LABEL.get(channel, channel)
        self.setWindowTitle(title or f"选择{label}（可试听）")
        self.setMinimumSize(560, 380)
        self.resize(880, 560)

        root = QVBoxLayout(self)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(6)

        # ---- 搜索行
        top = QHBoxLayout()
        self._filter = QLineEdit(self)
        self._filter.setPlaceholderText("搜 id 或文件名…（↑↓ 换行即试听，回车确定）")
        self._filter.setClearButtonEnabled(True)
        self._filter.textChanged.connect(self._apply_filter)
        self._filter.installEventFilter(self)
        top.addWidget(self._filter, stretch=1)
        self._only_broken = QCheckBox("只看有问题的", self)
        self._only_broken.setToolTip("只列出「文件缺失」「未登记」这类不能用的条目")
        self._only_broken.toggled.connect(lambda _on: self._apply_filter(self._filter.text()))
        top.addWidget(self._only_broken)
        root.addLayout(top)

        # ---- 列表
        self._tree = QTreeWidget(self)
        self._tree.setColumnCount(4)
        self._tree.setHeaderLabels(["id", "时长", "文件", "状态"])
        self._tree.setRootIsDecorated(False)
        self._tree.setAlternatingRowColors(True)
        self._tree.setUniformRowHeights(True)
        self._tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._tree.setSortingEnabled(True)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_menu)
        header = self._tree.header()
        header.setSectionResizeMode(_COL_ID, QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(_COL_DURATION, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(_COL_FILE, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(_COL_STATUS, QHeaderView.ResizeMode.ResizeToContents)
        self._tree.setColumnWidth(_COL_ID, 260)
        self._tree.currentItemChanged.connect(self._on_current_changed)
        self._tree.itemDoubleClicked.connect(lambda *_a: self._accept_current())
        self._tree.installEventFilter(self)
        root.addWidget(self._tree, stretch=1)

        # ---- 走带
        self._transport = AudioTransportBar(self)
        root.addWidget(self._transport)

        # ---- 底部
        bottom = QHBoxLayout()
        self._auto = QCheckBox("选中即试听", self)
        self._auto.setChecked(True)
        self._auto.setToolTip("方向键换行时自动播放当前行；关掉后用走带的 ▶ 手动播")
        bottom.addWidget(self._auto)
        self._count = QLabel("", self)
        self._count.setStyleSheet(theme.semantic_text_css("muted"))
        bottom.addWidget(self._count)
        bottom.addStretch(1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        if allow_manual_id:
            # 旧「可编辑下拉」唯一还值钱的能力：填一个尚未登记的 id（先接线、稍后补素材）。
            manual_btn = buttons.addButton("手输 id…", QDialogButtonBox.ButtonRole.ActionRole)
            manual_btn.setToolTip("填一个当前目录里还没有的 id（稍后再去「音频」页登记）")
            manual_btn.clicked.connect(self._manual_id)
        if allow_empty:
            clear_btn = buttons.addButton("清空", QDialogButtonBox.ButtonRole.ResetRole)
            clear_btn.setToolTip("清除当前引用并关闭（该字段将没有音频）")
            clear_btn.clicked.connect(self._clear_and_accept)
        buttons.accepted.connect(self._accept_current)
        buttons.rejected.connect(self.reject)
        bottom.addWidget(buttons)
        root.addLayout(bottom)

        self._rows = self._build_rows(rows)
        self._populate()
        self._cache.updated.connect(self._refresh_durations)
        self.finished.connect(lambda _r: self._on_finished())

        remember_dialog_geometry(self, f"audio_picker_{channel}")
        self._filter.setFocus()

    # ------------------------------------------------------------- 数据构建
    def _build_rows(
        self, rows: list[tuple[str, str]] | list[str],
    ) -> list[tuple[str, lib.AudioEntryInfo | None]]:
        """候选来自调用方（可能含目录外 id）；元数据来自 audio_config。"""
        infos = {
            info.audio_id: info
            for info in lib.channel_entries(self._model, self._channel, self._cache)
        }
        out: list[tuple[str, lib.AudioEntryInfo | None]] = []
        seen: set[str] = set()
        for row in rows:
            aid = str(row[0] if isinstance(row, tuple) else row).strip()
            if not aid or aid in seen:
                continue
            seen.add(aid)
            out.append((aid, infos.get(aid)))
        if self._current and self._current not in seen:
            # 悬垂/目录外当前值必须看得见，否则用户以为「没选」进而误清空
            out.insert(0, (self._current, infos.get(self._current)))
        self._cache.prefetch(
            info.path for _aid, info in out if info is not None and info.path is not None
        )
        return out

    def _populate(self) -> None:
        self._tree.setSortingEnabled(False)
        self._tree.clear()
        current_item: QTreeWidgetItem | None = None
        for aid, info in self._rows:
            item = _AudioRowItem()
            item.setText(_COL_ID, aid)
            item.setData(_COL_ID, _VALUE_ROLE, aid)
            self._fill_meta_columns(item, info)
            self._tree.addTopLevelItem(item)
            if aid == self._current:
                current_item = item
        self._tree.setSortingEnabled(True)
        if current_item is not None:
            self._tree.setCurrentItem(current_item)
            self._tree.scrollToItem(current_item)
        self._apply_filter(self._filter.text())

    def _fill_meta_columns(
        self, item: QTreeWidgetItem, info: lib.AudioEntryInfo | None,
    ) -> None:
        if info is None:
            item.setText(_COL_DURATION, "—")
            item.setData(_COL_DURATION, _SORT_ROLE, None)
            item.setText(_COL_FILE, "")
            item.setText(_COL_STATUS, "未登记")
            item.setToolTip(
                _COL_STATUS,
                f"该 id 不在 audio_config.{self._channel} 里；原值保留不改写，"
                "但运行时不会有声音——去「音频」页登记它，或改选一条已登记的。",
            )
            for col in range(4):
                item.setForeground(col, _color("warn"))
            return
        item.setData(_COL_DURATION, _SORT_ROLE, info.duration)
        item.setText(_COL_DURATION, lib.format_duration(info.duration))
        item.setText(_COL_FILE, info.file_name or "（未填 src）")
        item.setToolTip(_COL_FILE, info.src or "该条目没有填 src")
        if info.missing:
            item.setText(_COL_STATUS, "文件缺失" if info.src else "缺 src")
            item.setToolTip(
                _COL_STATUS,
                f"src={info.src or '(空)'} 解析不到 public/resources/runtime 下的文件",
            )
            for col in range(4):
                item.setForeground(col, _color("error"))
        else:
            item.setText(_COL_STATUS, "")
            for col in range(4):
                item.setData(col, Qt.ItemDataRole.ForegroundRole, None)

    def _refresh_durations(self) -> None:
        """后台探测有结果了：只改时长列，不动选中/排序位置。"""
        infos = {
            info.audio_id: info
            for info in lib.channel_entries(self._model, self._channel, self._cache)
        }
        for i in range(self._tree.topLevelItemCount()):
            item = self._tree.topLevelItem(i)
            info = infos.get(item.data(_COL_ID, _VALUE_ROLE))
            if info is None:
                continue
            item.setData(_COL_DURATION, _SORT_ROLE, info.duration)
            item.setText(_COL_DURATION, lib.format_duration(info.duration))

    # --------------------------------------------------------------- 过滤
    def _apply_filter(self, text: str) -> None:
        query = str(text or "").strip().casefold()
        only_broken = self._only_broken.isChecked()
        shown = 0
        for i in range(self._tree.topLevelItemCount()):
            item = self._tree.topLevelItem(i)
            haystack = "\n".join(
                (item.text(_COL_ID), item.text(_COL_FILE), item.text(_COL_STATUS)),
            ).casefold()
            hit = (not query or query in haystack) and (
                not only_broken or bool(item.text(_COL_STATUS))
            )
            item.setHidden(not hit)
            shown += 1 if hit else 0
        total = self._tree.topLevelItemCount()
        self._count.setText(f"{shown} / {total} 条")
        cur = self._tree.currentItem()
        if cur is not None and cur.isHidden():
            self._select_first_visible(audition=False)

    def _select_first_visible(self, *, audition: bool = True) -> None:
        for i in range(self._tree.topLevelItemCount()):
            item = self._tree.topLevelItem(i)
            if not item.isHidden():
                if not audition:
                    self._auto_guard(lambda: self._tree.setCurrentItem(item))
                else:
                    self._tree.setCurrentItem(item)
                return

    def _auto_guard(self, fn) -> None:
        """程序性移动当前行时不触发自动试听（过滤收窄不该突然出声）。"""
        was = self._auto.isChecked()
        self._auto.blockSignals(True)
        self._auto.setChecked(False)
        try:
            fn()
        finally:
            self._auto.setChecked(was)
            self._auto.blockSignals(False)

    # --------------------------------------------------------------- 试听
    def _on_current_changed(
        self, item: QTreeWidgetItem | None, _prev: QTreeWidgetItem | None,
    ) -> None:
        if item is None or not self._auto.isChecked():
            return
        # 连按方向键快速掠过时不该每行都起播；50ms 内的连续移动只放最后一条
        self._pending_sound = str(item.data(_COL_ID, _VALUE_ROLE) or "")
        QTimer.singleShot(60, self, self._play_pending)

    def _play_pending(self) -> None:
        aid = self._pending_sound
        if not aid:
            return
        cur = self._tree.currentItem()
        if cur is None or str(cur.data(_COL_ID, _VALUE_ROLE) or "") != aid:
            return  # 已经又换行了，交给后一次
        self._play_id(aid)

    def _play_id(self, audio_id: str) -> None:
        path = lib.audio_config_file_for_id(self._model, self._channel, audio_id)
        self._transport.play_file(path)

    # ----------------------------------------------------------- 键盘/菜单
    def eventFilter(self, obj, event):  # noqa: ANN001, D102
        if isinstance(event, QKeyEvent) and event.type() == QKeyEvent.Type.KeyPress:
            key = event.key()
            if obj is self._filter and key in (
                Qt.Key.Key_Down, Qt.Key.Key_Up, Qt.Key.Key_PageDown, Qt.Key.Key_PageUp,
            ):
                # 搜索框里按方向键直接开始在列表里走，不用先点一下列表
                self._tree.setFocus()
                if self._tree.currentItem() is None:
                    self._select_first_visible()
                else:
                    QApplication.sendEvent(self._tree, event)
                return True
            if obj is self._filter and key in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                if self._tree.currentItem() is None:
                    self._select_first_visible()
                self._accept_current()
                return True
            if obj is self._tree and key == Qt.Key.Key_Space:
                self._transport.replay()
                return True
            if obj is self._tree and key in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                self._accept_current()
                return True
        return super().eventFilter(obj, event)

    def _show_menu(self, pos) -> None:  # noqa: ANN001
        item = self._tree.itemAt(pos)
        if item is None:
            return
        aid = str(item.data(_COL_ID, _VALUE_ROLE) or "")
        menu = QMenu(self._tree)
        menu.addAction("试听", lambda: self._play_id(aid))
        menu.addAction("复制 id", lambda: QApplication.clipboard().setText(aid))
        path = lib.audio_config_file_for_id(self._model, self._channel, aid)
        act = menu.addAction("在文件管理器中显示", lambda: _reveal(path))
        act.setEnabled(path is not None)
        menu.exec(self._tree.viewport().mapToGlobal(pos))

    # --------------------------------------------------------------- 提交
    def selected_value(self) -> str:
        return self._selected

    def _accept_current(self) -> None:
        item = self._tree.currentItem()
        if item is not None and not item.isHidden():
            self._selected = str(item.data(_COL_ID, _VALUE_ROLE) or "")
        else:
            self._selected = self._current  # 没有有效选中 = 不改动
        self.accept()

    def _clear_and_accept(self) -> None:
        self._selected = ""
        self.accept()

    def _manual_id(self) -> None:
        text, ok = QInputDialog.getText(
            self,
            "手输音频 id",
            f"填一个 audio_config.{self._channel} 里还没有的 id：",
            text=self._current,
        )
        if not ok:
            return
        value = (text or "").strip()
        if not value:
            return
        self._selected = value
        self.accept()

    def _on_finished(self) -> None:
        self._transport.stop()
        if self._owns_cache:
            self._cache.stop()


def _color(kind: str):
    from PySide6.QtGui import QBrush, QColor

    return QBrush(QColor(theme.semantic_text_color(kind)))


def _reveal(path: Path | None) -> None:
    """在系统文件管理器里定位文件；失败静默（纯便利功能，不该打断挑音效）。"""
    if path is None:
        return
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", str(path)], check=False)
        elif sys.platform.startswith("win"):
            subprocess.run(["explorer", "/select,", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path.parent)], check=False)
    except (OSError, subprocess.SubprocessError):
        pass
