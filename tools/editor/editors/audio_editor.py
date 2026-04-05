"""Audio configuration editor."""

from __future__ import annotations



from pathlib import Path



from PySide6.QtCore import QUrl

from PySide6.QtWidgets import (

    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,

    QPushButton, QLabel, QTableWidget,

    QTableWidgetItem, QHeaderView, QMessageBox,

)



try:

    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

except ImportError:  # 极少数环境未带 QtMultimedia

    QAudioOutput = None  # type: ignore[misc,assignment]

    QMediaPlayer = None  # type: ignore[misc,assignment]



from ..project_model import ProjectModel

from ..shared.id_ref_selector import IdRefSelector





def audio_src_to_local_file(model: ProjectModel, src: str) -> Path | None:

    """把配置里的 ``src``（如 ``/assets/audio/a.wav``）解析为本地绝对路径。"""

    if model.project_path is None:

        return None

    s = (src or "").strip()

    if not s:

        return None

    try_abs = Path(s)

    if try_abs.is_absolute() and try_abs.is_file():

        return try_abs

    if s.startswith("/assets/"):

        rel = s.removeprefix("/assets/").strip("/")

        parts = [p for p in rel.split("/") if p]

        if not parts:

            return None

        p = model.assets_path.joinpath(*parts)

    else:

        p = model.assets_path / s.lstrip("/\\")

    try:

        p = p.resolve()

    except OSError:

        return None

    return p if p.is_file() else None





def _src_selector_in_row_cell(container: QWidget | None) -> IdRefSelector | None:

    if container is None:

        return None

    if isinstance(container, IdRefSelector):

        return container

    found = container.findChildren(IdRefSelector)

    return found[0] if found else None





class _AudioChannelTab(QWidget):

    def __init__(self, model: ProjectModel, channel: str, parent=None):

        super().__init__(parent)

        self._model = model

        self._channel = channel

        self._player: QMediaPlayer | None = None

        self._audio_out: QAudioOutput | None = None

        if QMediaPlayer is not None and QAudioOutput is not None:

            self._player = QMediaPlayer(self)

            self._audio_out = QAudioOutput(self)

            self._player.setAudioOutput(self._audio_out)

            self._audio_out.setVolume(0.85)



        lay = QVBoxLayout(self)

        self._table = QTableWidget(0, 2)

        self._table.setHorizontalHeaderLabels(["id", "src"])

        self._table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)

        self._table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)

        self._table.verticalHeader().setDefaultSectionSize(36)

        lay.addWidget(self._table)



        btns = QHBoxLayout()

        add_btn = QPushButton("+ Entry")

        add_btn.clicked.connect(self._add)

        del_btn = QPushButton("- Entry")

        del_btn.clicked.connect(self._delete)

        apply_btn = QPushButton("Apply")

        apply_btn.clicked.connect(self._apply)

        stop_btn = QPushButton("停止预览")

        stop_btn.clicked.connect(self._stop_preview)

        btns.addWidget(add_btn)

        btns.addWidget(del_btn)

        btns.addWidget(apply_btn)

        btns.addWidget(stop_btn)

        btns.addStretch()

        lay.addLayout(btns)



        if self._player is None:

            lay.addWidget(

                QLabel("当前环境无 QtMultimedia，无法预览（可照常编辑配置）。"),

            )

        self._refresh()



    def _stop_preview(self) -> None:

        if self._player is not None:

            self._player.stop()



    def _make_src_row_widget(self, initial_src: str) -> QWidget:

        wrap = QWidget()

        h = QHBoxLayout(wrap)

        h.setContentsMargins(2, 0, 4, 0)

        h.setSpacing(6)

        choices = self._model.audio_src_choices()

        items = list(choices)

        if initial_src and all(x[0] != initial_src for x in items):

            items = [(initial_src, initial_src)] + items

        sel = IdRefSelector(wrap, allow_empty=True)

        sel.setMinimumWidth(180)

        sel.set_items(items)

        sel.set_current(initial_src)

        h.addWidget(sel, stretch=1)

        play = QPushButton("▶")

        play.setFixedWidth(34)

        play.setToolTip("预览此行当前 src 指向的音频文件")

        if self._player is None:

            play.setEnabled(False)

            play.setToolTip("需要 PySide6.QtMultimedia")

        else:

            play.clicked.connect(lambda checked=False, s=sel: self._preview_src(s.current_id()))

        h.addWidget(play)

        return wrap



    def _preview_src(self, src: str) -> None:

        if self._player is None:

            return

        path = audio_src_to_local_file(self._model, src)

        if path is None:

            QMessageBox.warning(

                self,

                "音频预览",

                "无法解析或未找到文件。请确认已保存 src 且文件位于 public/assets 下。\n"

                f"src: {src or '(空)'}",

            )

            return

        self._player.stop()

        self._player.setSource(QUrl.fromLocalFile(str(path)))

        self._player.play()



    def _refresh(self) -> None:

        entries = self._model.audio_config.get(self._channel, {})

        self._table.setRowCount(len(entries))

        for i, (aid, obj) in enumerate(entries.items()):

            self._table.setItem(i, 0, QTableWidgetItem(aid))

            src = obj.get("src", "") or ""

            self._table.setCellWidget(i, 1, self._make_src_row_widget(src))



    def _add(self) -> None:

        r = self._table.rowCount()

        self._table.insertRow(r)

        self._table.setItem(r, 0, QTableWidgetItem(""))

        self._table.setCellWidget(r, 1, self._make_src_row_widget(""))



    def _delete(self) -> None:

        r = self._table.currentRow()

        if r >= 0:

            self._table.removeRow(r)



    def _apply(self) -> None:

        ch: dict = {}

        for i in range(self._table.rowCount()):

            aid_item = self._table.item(i, 0)

            sel = _src_selector_in_row_cell(self._table.cellWidget(i, 1))

            if aid_item and aid_item.text().strip():

                src_txt = sel.current_id().strip() if isinstance(sel, IdRefSelector) else ""

                ch[aid_item.text().strip()] = {"src": src_txt}

        self._model.audio_config[self._channel] = ch

        self._model.mark_dirty("audio")





class AudioEditor(QWidget):

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):

        super().__init__(parent)

        lay = QVBoxLayout(self)

        tabs = QTabWidget()

        tabs.addTab(_AudioChannelTab(model, "bgm"), "BGM")

        tabs.addTab(_AudioChannelTab(model, "ambient"), "Ambient")

        tabs.addTab(_AudioChannelTab(model, "sfx"), "SFX")

        lay.addWidget(tabs)


