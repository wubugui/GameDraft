"""Audio configuration editor."""

from __future__ import annotations



from pathlib import Path

from typing import Callable



from PySide6.QtCore import QUrl

from PySide6.QtWidgets import (

    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,

    QPushButton, QLabel, QTableWidget,

    QTableWidgetItem, QHeaderView, QMessageBox,

    QLineEdit,

    QFileDialog,

)



try:

    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

except ImportError:  # 极少数环境未带 QtMultimedia

    QAudioOutput = None  # type: ignore[misc,assignment]

    QMediaPlayer = None  # type: ignore[misc,assignment]



from ..project_model import ProjectModel

from ..shared.id_ref_selector import IdRefSelector

from ..shared.project_paths import DIR_KIND_RUNTIME_AUDIO, URL_KIND_MEDIA





def audio_src_to_local_file(model: ProjectModel, src: str) -> Path | None:

    """把音频 ``src``（``/resources/runtime/audio/a.wav`` 或短名）解析为本地存在文件。

    迁移后音频媒体不允许落在 ``/assets/...``；解析委托给 ``ProjectPaths.url_to_disk``。
    """

    if model.project_path is None:

        return None

    p = model.paths.url_to_disk(src, kind=URL_KIND_MEDIA)

    if p is None:

        return None

    try:

        p = p.resolve()

    except OSError:

        return None

    return p if p.is_file() else None





_AUDIO_FILE_FILTER = "音频 (*.wav *.ogg *.mp3 *.m4a *.flac);;所有文件 (*.*)"


def _disk_path_to_runtime_url(model: ProjectModel, path: Path) -> str | None:
    """音频选择器：仅接受 ``public/resources/runtime`` 下的文件。"""

    if model.project_path is None:

        return None

    return model.paths.disk_to_runtime_url(path)





class _AudioSrcRow(QWidget):

    """只读显示 ``/resources/runtime/...``，文件选择器默认到 ``public/resources/runtime/audio`` 下，禁止手打路径。"""

    def __init__(

        self,

        model: ProjectModel,

        initial_src: str,

        player: QMediaPlayer | None,

        preview_fn: Callable[[str], None],

        parent=None,

    ):

        super().__init__(parent)

        self._model = model

        self._player = player

        self._preview_fn = preview_fn

        self._src = (initial_src or "").strip()

        h = QHBoxLayout(self)

        h.setContentsMargins(2, 0, 4, 0)

        h.setSpacing(6)

        self._edit = QLineEdit(self._src)

        self._edit.setReadOnly(True)

        self._edit.setPlaceholderText("点此侧「选择文件…」，起始目录为 public/resources/runtime/audio")

        self._edit.setMinimumWidth(180)

        browse = QPushButton("选择文件…")

        browse.setToolTip("打开文件选择器，默认目录 public/resources/runtime/audio；只接受 runtime 树下的文件")

        browse.clicked.connect(self._on_browse)

        clear_btn = QPushButton("清除")

        clear_btn.setToolTip("清空 src")

        clear_btn.clicked.connect(self._on_clear)

        h.addWidget(self._edit, stretch=1)

        h.addWidget(browse)

        h.addWidget(clear_btn)

        play = QPushButton("▶")

        play.setFixedWidth(34)

        play.setToolTip("预览此行当前 src 指向的音频文件")

        if self._player is None:

            play.setEnabled(False)

            play.setToolTip("需要 PySide6.QtMultimedia")

        else:

            play.clicked.connect(self._on_play)

        h.addWidget(play)



    def current_src(self) -> str:

        return self._src



    def _set_src(self, src: str) -> None:

        self._src = (src or "").strip()

        self._edit.setText(self._src)



    def _on_clear(self) -> None:

        self._set_src("")



    def _default_audio_dialog_dir(self) -> str:

        d = self._model.paths.default_dir(DIR_KIND_RUNTIME_AUDIO)

        try:

            d.mkdir(parents=True, exist_ok=True)

        except OSError:

            pass

        return str(d.resolve())



    def _on_browse(self) -> None:

        path_str, _ = QFileDialog.getOpenFileName(

            self,

            "选择音频文件",

            self._default_audio_dialog_dir(),

            _AUDIO_FILE_FILTER,

        )

        if not path_str:

            return

        url = _disk_path_to_runtime_url(self._model, Path(path_str))

        if not url:

            QMessageBox.warning(

                self,

                "音频路径",

                "迁移后音频必须放在 public/resources/runtime/audio 下，请把文件移动过来再选择。",

            )

            return

        self._set_src(url)



    def _on_play(self) -> None:

        self._preview_fn(self._src)



def _audio_src_cell_picker(container: QWidget | None) -> _AudioSrcRow | None:

    if container is None:

        return None

    if isinstance(container, _AudioSrcRow):

        return container

    found = container.findChildren(_AudioSrcRow)

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

        return _AudioSrcRow(

            self._model,

            initial_src,

            self._player,

            self._preview_src,

            self,

        )



    def _preview_src(self, src: str) -> None:

        if self._player is None:

            return

        path = audio_src_to_local_file(self._model, src)

        if path is None:

            QMessageBox.warning(

                self,

                "音频预览",

                "无法解析或未找到文件。请确认已保存 src 且文件位于 public/resources/runtime 下。\n"

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

            row = _audio_src_cell_picker(self._table.cellWidget(i, 1))

            if aid_item and aid_item.text().strip():

                src_txt = row.current_src().strip() if row else ""

                ch[aid_item.text().strip()] = {"src": src_txt}

        self._model.audio_config[self._channel] = ch

        self._model.mark_dirty("audio")





class _SystemSfxTab(QWidget):

    def __init__(self, model: ProjectModel, parent=None):

        super().__init__(parent)

        self._model = model

        lay = QVBoxLayout(self)

        lay.addWidget(QLabel("System event keys mapped to SFX ids. Leave the SFX id empty to disable that sound."))

        self._table = QTableWidget(0, 2)

        self._table.setHorizontalHeaderLabels(["system key", "sfx id"])

        self._table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)

        self._table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)

        self._table.verticalHeader().setDefaultSectionSize(36)

        lay.addWidget(self._table)

        btns = QHBoxLayout()

        add_btn = QPushButton("+ Mapping")

        add_btn.clicked.connect(self._add)

        del_btn = QPushButton("- Mapping")

        del_btn.clicked.connect(self._delete)

        apply_btn = QPushButton("Apply")

        apply_btn.clicked.connect(self._apply)

        btns.addWidget(add_btn)

        btns.addWidget(del_btn)

        btns.addWidget(apply_btn)

        btns.addStretch()

        lay.addLayout(btns)

        self._refresh()


    def _make_sfx_selector(self, initial_id: str) -> IdRefSelector:

        items = [(sid, sid) for sid in self._model.all_audio_ids("sfx")]

        if initial_id and all(x[0] != initial_id for x in items):

            items = [(initial_id, initial_id)] + items

        sel = IdRefSelector(self, allow_empty=True, editable=True)

        sel.set_items(items)

        sel.set_current(initial_id)

        return sel


    def _refresh(self) -> None:

        entries = self._model.audio_config.get("systemSfx", {})

        if not isinstance(entries, dict):

            entries = {}

        self._table.setRowCount(len(entries))

        for i, (key, sfx_id) in enumerate(entries.items()):

            self._table.setItem(i, 0, QTableWidgetItem(str(key)))

            self._table.setCellWidget(i, 1, self._make_sfx_selector(str(sfx_id or "")))


    def _add(self) -> None:

        r = self._table.rowCount()

        self._table.insertRow(r)

        self._table.setItem(r, 0, QTableWidgetItem(""))

        self._table.setCellWidget(r, 1, self._make_sfx_selector(""))


    def _delete(self) -> None:

        r = self._table.currentRow()

        if r >= 0:

            self._table.removeRow(r)


    def _apply(self) -> None:

        out: dict[str, str] = {}

        for i in range(self._table.rowCount()):

            key_item = self._table.item(i, 0)

            key = key_item.text().strip() if key_item else ""

            sel = self._table.cellWidget(i, 1)

            sfx_id = sel.current_id().strip() if isinstance(sel, IdRefSelector) else ""

            if key:

                out[key] = sfx_id

        self._model.audio_config["systemSfx"] = out

        self._model.mark_dirty("audio")


class AudioEditor(QWidget):

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):

        super().__init__(parent)

        lay = QVBoxLayout(self)

        tabs = QTabWidget()

        tabs.addTab(_AudioChannelTab(model, "bgm"), "BGM")

        tabs.addTab(_AudioChannelTab(model, "ambient"), "Ambient")

        tabs.addTab(_AudioChannelTab(model, "sfx"), "SFX")

        tabs.addTab(_SystemSfxTab(model), "System SFX")

        lay.addWidget(tabs)
