"""Audio configuration editor."""

from __future__ import annotations



from pathlib import Path

from typing import Callable



from PySide6.QtCore import QUrl, Qt, Signal

from PySide6.QtGui import QKeyEvent

from PySide6.QtWidgets import (

    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,

    QPushButton, QLabel, QTableWidget,

    QTableWidgetItem, QHeaderView, QMessageBox,

    QLineEdit, QMenu,

    QFileDialog,

)



try:

    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

except ImportError:  # 极少数环境未带 QtMultimedia

    QAudioOutput = None  # type: ignore[misc,assignment]

    QMediaPlayer = None  # type: ignore[misc,assignment]



from ..project_model import ProjectModel

from ..shared.audio_preview_selector import AudioIdPreviewSelector

from ..shared.id_ref_selector import IdRefSelector

from ..shared.list_affordances import make_table_search_box

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

    applied = Signal()  # Apply 后发出(System SFX 子页据此刷新 sfx id 下拉候选)

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

        self._table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)

        self._table.customContextMenuRequested.connect(self._show_table_menu)

        self._table.installEventFilter(self)

        self._search = make_table_search_box(
            self._table,
            tooltip="按音频 id 过滤下方行（仅隐藏不匹配项，不改动数据）。")
        lay.addWidget(self._search)
        lay.addWidget(self._table)



        btns = QHBoxLayout()

        add_btn = QPushButton("+ Entry")

        add_btn.setToolTip("新增一行音频条目（先填 id，再「选择文件…」绑定 src）")

        add_btn.clicked.connect(self._add)

        del_btn = QPushButton("- Entry")

        del_btn.setToolTip("删除当前选中行（Delete 键 / 右键菜单亦可）")

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

        # 重新套用搜索过滤，使 setRowHidden 与新内容一致
        self._search.textChanged.emit(self._search.text())



    def _add(self) -> None:

        r = self._table.rowCount()

        self._table.insertRow(r)

        self._table.setItem(r, 0, QTableWidgetItem(""))

        self._table.setCellWidget(r, 1, self._make_src_row_widget(""))



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



    def _build_channel(self) -> dict:
        """从表格构建本频道的 {id: entry} 字典(不写模型),供 _apply 与 _is_dirty 共用。"""
        old_ch = self._model.audio_config.get(self._channel)
        old_ch = old_ch if isinstance(old_ch, dict) else {}
        ch: dict = {}
        for i in range(self._table.rowCount()):
            aid_item = self._table.item(i, 0)
            row = _audio_src_cell_picker(self._table.cellWidget(i, 1))
            if aid_item and aid_item.text().strip():
                aid = aid_item.text().strip()
                src_txt = row.current_src().strip() if row else ""
                # 保留同 id 原条目的未知键（volume 等未来字段），只更新 src
                prev = old_ch.get(aid)
                entry = dict(prev) if isinstance(prev, dict) else {}
                entry["src"] = src_txt
                ch[aid] = entry
        return ch

    def _is_dirty(self) -> bool:
        ch = self._build_channel()
        old = self._model.audio_config.get(self._channel)
        if old is None:
            return bool(ch)  # 频道键本就缺失:只有真加了条目才算脏(避免打开即脏)
        return ch != (old if isinstance(old, dict) else {})

    def _apply(self) -> None:
        ch = self._build_channel()
        # 无实质变化不写不标脏：堵住"每次 Save All 重写 audio_config.json"
        if not self._is_dirty():
            return
        self._model.audio_config[self._channel] = ch

        self._model.mark_dirty("audio")
        self.applied.emit()





# 运行时实际会触发的 system 事件键。权威来源:src/systems/AudioManager.ts 中
# 所有 playSystemSfx('<key>') 调用。新增运行时事件时同步此表(下拉仍可编辑,
# 未在表内的旧键不会被丢弃)。
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

    def __init__(self, model: ProjectModel, parent=None):

        super().__init__(parent)

        self._model = model

        lay = QVBoxLayout(self)

        self._table = QTableWidget(0, 2)

        self._table.setToolTip(
            "System event keys mapped to SFX ids. Leave the SFX id empty to disable that sound.")

        self._table.setHorizontalHeaderLabels(["system key", "sfx id"])

        self._table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)

        self._table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)

        self._table.verticalHeader().setDefaultSectionSize(36)

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
        """system 事件键改用可编辑下拉:候选取自运行时枚举,避免手打错;
        可编辑 + 孤儿前置,既不限制旧键也不静默丢弃既有数据。"""
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

        sel.setToolTip("systemSfx 使用的 sfx id；右侧按钮可试听当前选择。")

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
            sfx_id = sel.current_id().strip() if isinstance(sel, (IdRefSelector, AudioIdPreviewSelector)) else ""
            if key:
                out[key] = sfx_id
        return out

    def _is_dirty(self) -> bool:
        out = self._build_mapping()
        old = self._model.audio_config.get("systemSfx")
        if old is None:
            return bool(out)  # systemSfx 键本就缺失:只有真加了映射才算脏(避免打开即脏)
        return out != old

    def refresh_sfx_choices(self) -> None:
        """SFX 子页新增 sfx id 后,刷新本页每行下拉候选(编辑器内自刷,不必重开工程)。
        保留各行当前选择(悬垂/未登记值仍前置保值)。"""
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

        lay = QVBoxLayout(self)

        tabs = QTabWidget()

        # 保留子页引用，供 Save All 时统一提交（否则未点 Apply 的音频表编辑会被静默丢弃）。
        self._sub_tabs = [
            _AudioChannelTab(model, "bgm"),
            _AudioChannelTab(model, "ambient"),
            _AudioChannelTab(model, "sfx"),
            _SystemSfxTab(model),
        ]

        tabs.addTab(self._sub_tabs[0], "BGM")

        tabs.addTab(self._sub_tabs[1], "Ambient")

        tabs.addTab(self._sub_tabs[2], "SFX")

        tabs.addTab(self._sub_tabs[3], "System SFX")

        # SFX 子页 Apply 后,System SFX 子页的 sfx id 下拉候选立即刷新(编辑器内自刷)。
        self._sub_tabs[2].applied.connect(self._sub_tabs[3].refresh_sfx_choices)

        self._tabs = tabs
        lay.addWidget(tabs)

    def select_by_id(self, audio_id: str, _scene_id: str = "") -> bool:
        """全局搜索/跳转落点：在四个音频子页的表格里按 id/键定位并切页选中。

        System SFX 子页第 0 列是 cellWidget(IdRefSelector),table.item(r,0) 恒 None——
        必须走该页的 _key_at(r) 取键,否则匹配恒空、跳转静默失败还谎报已定位(审查 P2)。
        返回是否命中(导航诚实化:未命中报错不聚光)。"""
        target = (audio_id or "").strip()
        if not target:
            return False
        for idx, tab in enumerate(self._sub_tabs):
            table = getattr(tab, "_table", None)
            if table is None:
                continue
            key_at = getattr(tab, "_key_at", None)  # System SFX 用 cellWidget,走 _key_at
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

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        """Save All 钩子：提交各音频子页表格的未应用编辑。表驱动 _apply 无条件提交安全——
        只写当前表状态，未编辑写回等值数据，保存后清脏。"""
        for tab in self._sub_tabs:
            ap = getattr(tab, "_apply", None)
            if callable(ap):
                ap()
        return True

    def confirm_close(self, parent=None) -> bool:
        """关闭/切工程门控：有未应用编辑则 Save/Discard/Cancel(对齐 item/shop 口径)。
        Discard 按契约把各子页表格回滚到模型值(_refresh),避免关闭路径统一 flush 复活。"""
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
                tab._refresh()  # 回滚 UI 到模型值,中和后续统一 flush
        return True
