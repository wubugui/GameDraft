"""连续对白段的聚合编辑对话框（过场编辑器「批量编辑这段对白 / 新建对话块」）。

形态：一句一行，折叠时只编正文（连着写一段台词很快）；**单条可展开，且同时只展开一条**，
展开后就是外层那套完整表单——直接复用 `StepWidget`，不另写一份。

为什么必须复用 StepWidget 而不是自己摆控件：它的 `to_dict()` 是步骤序列化的权威实现。
自己另写一套的代价已经付过一次——凭空给 showSubtitle 写出 speaker 键、往返即不等价。
复用之后，保真契约自动成立。

整段粘贴走「从文本导入」：那里才做启发式切分（豁免方括号内冒号、长前缀退回整行），
因为本工程 146 条台词里 33 条正文自带冒号、18 条含 `[tag:…]`，按冒号硬切必然误切。
"""
from __future__ import annotations

from copy import deepcopy

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QToolButton,
    QVBoxLayout,
    QWidget,
)


def _has_speaker_field(step: dict) -> bool:
    """本步是否吃 speaker：只有 showDialogue 吃。

    showSubtitle 没有这个字段，给它写一个空 speaker 就是凭空多一个运行时不消费的键，
    往返即不等价（编辑器铁律：打开→不动→保存必须与磁盘等价）。
    """
    return str(step.get("type") or "") == "showDialogue"


def new_dialogue_step(template: dict | None = None) -> dict:
    """新的一句：继承模板的说话人/立绘等设置，正文留空。"""
    base = deepcopy(template) if isinstance(template, dict) else None
    if not base or str(base.get("kind")) != "present":
        base = {"kind": "present", "type": "showDialogue"}
    base["text"] = ""
    # 新句永远是启用的：模板恰好是被禁用的那句时，别把"不播"也继承过来
    base.pop("disabled", None)
    if _has_speaker_field(base):
        base.setdefault("speaker", "")
    return base


class _EditorProxy:
    """给对话框内 StepWidget 用的宿主替身。

    转发场景上下文（NPC / 出生点 / 动画候选要靠它才正确），但**吞掉
    mark_pending_changes**：对话框里的改动在点 OK 前不该把外层标脏，
    否则用户取消后会留下假脏标记。StepWidget 用 hasattr 门控，缺席即不标脏。
    """

    def __init__(self, editor):
        self._editor = editor
        self._theme_id = getattr(editor, "_theme_id", None)

    def cutscene_binding_target_scene(self) -> str:
        ed = self._editor
        if ed is not None and hasattr(ed, "cutscene_binding_target_scene"):
            try:
                return ed.cutscene_binding_target_scene()
            except Exception:  # noqa: BLE001
                return ""
        return ""

    def __getattr__(self, name):
        if name == "mark_pending_changes":
            raise AttributeError(name)
        return getattr(self._editor, name)


class _DialogueLineRow(QFrame):
    """一句台词的行：折叠态只编正文，展开态挂完整 StepWidget。"""

    expand_requested = Signal(object)
    delete_requested = Signal(object)
    changed = Signal()

    def __init__(self, data: dict, model, editor_proxy, step_widget_cls,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self._data = deepcopy(data)
        self._model = model
        self._proxy = editor_proxy
        self._step_cls = step_widget_cls
        self._step = None          # 展开期间的 StepWidget
        self._origin_step_no: int | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(4, 2, 4, 2)
        root.setSpacing(2)

        head = QHBoxLayout()
        head.setSpacing(6)

        self._btn_expand = QToolButton(self)
        self._btn_expand.setAutoRaise(True)
        self._btn_expand.setFixedSize(22, 22)
        self._btn_expand.setArrowType(Qt.ArrowType.RightArrow)
        self._btn_expand.setToolTip(
            "展开成完整表单（说话人实体 / 立绘 / 语音 / 自动推进…），与外层编辑完全一致")
        self._btn_expand.clicked.connect(lambda: self.expand_requested.emit(self))
        head.addWidget(self._btn_expand)

        self._no_lbl = QLabel(self)
        self._no_lbl.setFixedWidth(64)
        self._no_lbl.setStyleSheet("color: #868e96;")
        head.addWidget(self._no_lbl)

        self._speaker = QLineEdit(self)
        self._speaker.setFixedWidth(130)
        self._speaker.setPlaceholderText("说话人")
        self._speaker.setToolTip("留空 = 旁白；可用 {{player}} / {{npc}} 占位与 [tag:…] 引用")
        self._speaker.textEdited.connect(self._on_speaker_edited)
        head.addWidget(self._speaker)

        self._text = QLineEdit(self)
        self._text.setPlaceholderText("台词…")
        self._text.textEdited.connect(self._on_text_edited)
        head.addWidget(self._text, stretch=1)

        self._btn_del = QToolButton(self)
        self._btn_del.setText("✕")
        self._btn_del.setAutoRaise(True)
        self._btn_del.setFixedSize(22, 22)
        self._btn_del.setToolTip("删除这一句")
        self._btn_del.clicked.connect(lambda: self.delete_requested.emit(self))
        head.addWidget(self._btn_del)

        root.addLayout(head)

        self._detail = QWidget(self)
        self._detail_lay = QVBoxLayout(self._detail)
        self._detail_lay.setContentsMargins(26, 2, 2, 4)
        self._detail.setVisible(False)
        root.addWidget(self._detail)

        self._sync_collapsed_fields()

    # ---- 折叠态字段 ----

    def set_origin_step_no(self, no: int | None) -> None:
        """外层的真实步号——「这句对应外面第几步」，编完对得上位置。"""
        self._origin_step_no = no
        self._no_lbl.setText(f"第 {no} 步" if no else "新增")

    def origin_step_no(self) -> int | None:
        return self._origin_step_no

    def _sync_collapsed_fields(self) -> None:
        d = self._data
        # 禁用句（外层大纲行上标的）：这里只如实显示 + 原样带走，不在本对话框里改
        disabled = d.get("disabled") is True
        for w in (self._speaker, self._text):
            f = w.font()
            f.setStrikeOut(disabled)
            w.setFont(f)
        self.setToolTip("这一句已被禁用：数据留着，播放时整步跳过。" if disabled else "")
        has_sp = _has_speaker_field(d)
        self._speaker.setVisible(has_sp)
        if has_sp:
            self._speaker.setText(str(d.get("speaker") or ""))
        txt = str(d.get("text") or "")
        if "\n" in txt:
            # 多行台词压不进单行框：只读展示，要改必须展开（否则一保存就丢换行）
            self._text.setText(txt.replace("\n", " ⏎ "))
            self._text.setReadOnly(True)
            self._text.setToolTip("这句是多行台词——展开后编辑，避免在单行里丢掉换行。")
        else:
            self._text.setText(txt)
            self._text.setReadOnly(False)
            self._text.setToolTip("")

    def _on_text_edited(self, s: str) -> None:
        if not self._text.isReadOnly():
            self._data["text"] = s
            self.changed.emit()

    def _on_speaker_edited(self, s: str) -> None:
        if _has_speaker_field(self._data):
            self._data["speaker"] = s
            self.changed.emit()

    # ---- 展开 / 收起 ----

    def is_expanded(self) -> bool:
        return self._step is not None

    def set_expanded(self, on: bool) -> None:
        if on == self.is_expanded():
            return
        if on:
            self._data = self._collect_collapsed()
            self._step = self._step_cls(
                self._data, self._model, self._proxy, self._detail,
                parallel_parent=None, cutscene_id=None,
            )
            self._step.contentChanged.connect(self.changed.emit)
            self._detail_lay.addWidget(self._step)
            self._detail.setVisible(True)
            self._btn_expand.setArrowType(Qt.ArrowType.DownArrow)
            # 展开期间以完整表单为准，折叠态两个框让位（免得两处各写一半）
            self._speaker.setEnabled(False)
            self._text.setEnabled(False)
        else:
            if self._step is not None:
                try:
                    self._data = self._step.to_dict()
                except Exception:  # noqa: BLE001 — 收起失败不该吞掉这一句
                    pass
                self._detail_lay.removeWidget(self._step)
                self._step.setParent(None)
                self._step.deleteLater()
                self._step = None
            self._detail.setVisible(False)
            self._btn_expand.setArrowType(Qt.ArrowType.RightArrow)
            self._speaker.setEnabled(True)
            self._text.setEnabled(True)
            self._sync_collapsed_fields()
        self.changed.emit()

    # ---- 取值 ----

    def _collect_collapsed(self) -> dict:
        d = deepcopy(self._data)
        if not self._text.isReadOnly():
            d["text"] = self._text.text()
        if _has_speaker_field(d):
            d["speaker"] = self._speaker.text()
        return d

    def to_dict(self) -> dict:
        if self._step is not None:
            try:
                return self._step.to_dict()
            except Exception:  # noqa: BLE001
                return deepcopy(self._data)
        return self._collect_collapsed()


class DialogueRunEditorDialog(QDialog):
    """连续对白段的聚合编辑器（也用于新建对话块）。

    `result_steps()` 返回编辑后的完整步骤列表（顺序即最终顺序）。
    """

    def __init__(self, steps: list[dict], model=None, editor=None,
                 parent: QWidget | None = None, *,
                 first_step_no: int | None = None,
                 creating: bool = False) -> None:
        super().__init__(parent)
        self.setWindowTitle("新建对话块" if creating else "批量编辑对白")
        self.resize(940, 560)
        self._origin: list[dict] = [deepcopy(s) for s in steps]
        self._model = model
        self._proxy = _EditorProxy(editor) if editor is not None else None
        self._first_no = first_step_no
        self._rows: list[_DialogueLineRow] = []
        # 延迟导入：timeline_editor 会 import 本模块，顶层导入将成循环依赖
        from ..editors.timeline_editor import StepWidget
        self._step_cls = StepWidget

        root = QVBoxLayout(self)
        tip = QLabel(
            "一句一行，直接改台词；点左侧箭头可<b>展开单条</b>，展开后就是外层那套完整表单"
            "（说话人实体 / 立绘 / 语音 / 自动推进…），同时只展开一条。",
            self,
        )
        tip.setWordWrap(True)
        root.addWidget(tip)

        self._scroll = QScrollArea(self)
        self._scroll.setWidgetResizable(True)
        self._host = QWidget()
        self._host_lay = QVBoxLayout(self._host)
        self._host_lay.setContentsMargins(0, 0, 0, 0)
        self._host_lay.setSpacing(3)
        self._scroll.setWidget(self._host)
        root.addWidget(self._scroll, stretch=1)

        for st in self._origin:
            self._add_row(st)
        if not self._rows:
            self._add_row(new_dialogue_step(None))

        btns = QHBoxLayout()
        for label, tip_text, slot in (
            ("+ 一句", "在末尾接一句（继承最后一句的说话人与立绘设置）", self._add_line),
            ("↑", "上移当前行", lambda: self._move(-1)),
            ("↓", "下移当前行", lambda: self._move(1)),
        ):
            b = QPushButton(label, self)
            b.setToolTip(tip_text)
            b.clicked.connect(slot)
            btns.addWidget(b)
        btns.addStretch(1)
        b_import = QPushButton("从文本导入…", self)
        b_import.setToolTip(
            "粘贴一整段剧本，按行拆句、按首个冒号猜说话人；"
            "方括号内冒号（[tag:…]）不参与拆分，结果先填进列表供核对。"
        )
        b_import.clicked.connect(self._import_from_text)
        btns.addWidget(b_import)
        root.addLayout(btns)

        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        root.addWidget(box)
        self._renumber()

    # ---- 行管理 ----

    def _add_row(self, data: dict, at: int | None = None) -> _DialogueLineRow:
        row = _DialogueLineRow(data, self._model, self._proxy, self._step_cls, self._host)
        row.expand_requested.connect(self._on_expand_requested)
        row.delete_requested.connect(self._on_delete_requested)
        idx = len(self._rows) if at is None else at
        self._rows.insert(idx, row)
        self._host_lay.insertWidget(idx, row)
        return row

    def _renumber(self) -> None:
        """行号显示外层真实步号——编完知道这句落在外面第几步。"""
        for i, row in enumerate(self._rows):
            if self._first_no is None or i >= len(self._origin):
                row.set_origin_step_no(None)
            else:
                row.set_origin_step_no(self._first_no + i)

    def _on_expand_requested(self, row: _DialogueLineRow) -> None:
        """手风琴：展一条自动收起其它所有条。"""
        if row.is_expanded():
            row.set_expanded(False)
            return
        for other in self._rows:
            if other is not row and other.is_expanded():
                other.set_expanded(False)
        row.set_expanded(True)
        self._scroll.ensureWidgetVisible(row)

    def _on_delete_requested(self, row: _DialogueLineRow) -> None:
        if len(self._rows) <= 1:
            QMessageBox.information(
                self, "对白", "至少保留一句；要整段删除请在步骤列表里操作。")
            return
        self._rows.remove(row)
        self._host_lay.removeWidget(row)
        row.setParent(None)
        row.deleteLater()
        self._renumber()

    def _current_row(self) -> _DialogueLineRow | None:
        for r in self._rows:
            if r.is_expanded() or r._text.hasFocus() or r._speaker.hasFocus():
                return r
        return self._rows[-1] if self._rows else None

    def _add_line(self) -> None:
        tmpl = self._rows[-1].to_dict() if self._rows else None
        row = self._add_row(new_dialogue_step(tmpl))
        self._renumber()
        self._scroll.ensureWidgetVisible(row)
        row._text.setFocus()

    def _move(self, delta: int) -> None:
        cur = self._current_row()
        if cur is None:
            return
        i = self._rows.index(cur)
        j = i + delta
        if not (0 <= j < len(self._rows)):
            return
        self._rows.pop(i)
        self._host_lay.removeWidget(cur)
        self._rows.insert(j, cur)
        self._host_lay.insertWidget(j, cur)
        self._renumber()
        self._scroll.ensureWidgetVisible(cur)

    # ---- 整段导入 ----

    def _import_from_text(self) -> None:
        dlg = _PasteScriptDialog(self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        rows = dlg.parsed_rows()
        if not rows:
            return
        r = QMessageBox.question(
            self, "从文本导入",
            f"解析出 {len(rows)} 句。替换当前的 {len(self._rows)} 句？\n"
            "（其它设置按位置继承原有各句；多出的句子继承最后一句。）",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        templates = [row.to_dict() for row in self._rows]
        for row in list(self._rows):
            self._host_lay.removeWidget(row)
            row.setParent(None)
            row.deleteLater()
        self._rows.clear()
        for i, (spk, txt) in enumerate(rows):
            base = deepcopy(templates[i] if i < len(templates)
                            else (templates[-1] if templates else None))
            step = new_dialogue_step(base)
            step["text"] = txt
            if _has_speaker_field(step):
                step["speaker"] = spk
            self._add_row(step)
        self._renumber()

    # ---- 结果 ----

    def result_steps(self) -> list[dict]:
        return [row.to_dict() for row in self._rows]

    def changed_from_origin(self) -> bool:
        return self.result_steps() != self._origin


class _PasteScriptDialog(QDialog):
    """整段剧本粘贴：按行拆句，按首个「不在方括号内」的冒号猜说话人。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("从文本导入对白")
        self.resize(620, 420)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel(
            "一行一句。「说话人：台词」会拆成两列；没有冒号的整行当作台词（旁白）。\n"
            "方括号里的冒号（如 [tag:string:…]）不参与拆分。空行忽略。", self))
        self._edit = QPlainTextEdit(self)
        self._edit.setPlaceholderText("说书人：那旱魃张口喷火，扑爪带风；\n李天狗：呔！")
        lay.addWidget(self._edit, stretch=1)
        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self)
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)

    def parsed_rows(self) -> list[tuple[str, str]]:
        return parse_script_lines(self._edit.toPlainText())


def split_speaker_line(line: str) -> tuple[str, str]:
    """按首个「不在方括号内」的中/英文冒号拆 (speaker, text)；无冒号则全作台词。

    方括号豁免是必须的：本工程 18 条台词含 `[tag:string:…]` 引用，
    裸按冒号切会把引用拦腰砍断。
    """
    depth = 0
    for i, ch in enumerate(line):
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth = max(0, depth - 1)
        elif ch in ("：", ":") and depth == 0:
            speaker = line[:i].strip()
            text = line[i + 1:].strip()
            # 「：台词」这种空说话人写法 = 显式旁白
            return speaker, text
    return "", line.strip()


def parse_script_lines(raw: str) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for line in (raw or "").splitlines():
        s = line.strip()
        if not s:
            continue
        spk, txt = split_speaker_line(s)
        # 说话人不该是一整句话——过长十有八九是台词里的冒号，整行退回台词
        if len(spk) > 12:
            spk, txt = "", s
        rows.append((spk, txt))
    return rows
