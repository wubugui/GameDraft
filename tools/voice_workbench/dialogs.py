"""批量操作对话框:打标签、批量改参数、批量重命名。

这三个都遵同一条规矩:**先给预览/三态,再动数据**。
批量操作最贵的一脚是"手滑一次全废",而它们又必须一次作用于几十条,
所以每一个都要能在按下确定之前看清楚"到底会变成什么样"。

重命名尤其:产物文件名就是 ``audio_config`` 里 ``src`` 的最后一段,
**已导出的条目改名 = 重构,不是打字**。所以它默认连带改名磁盘上的产物
(理由见 RenameDialog 的文档字符串)。
"""
from __future__ import annotations

import re
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QDialog, QDialogButtonBox,
    QDoubleSpinBox, QFormLayout, QGroupBox, QHBoxLayout, QHeaderView, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QPushButton, QRadioButton,
    QSpinBox, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .project import Slice, clean_tags, sanitize_name, sanitize_tag

#: 冲突级别:红 = 拦住不让确定,黄 = 提醒但可以继续
_BAD = "#c92a2a"
_WARN = "#e8590c"
_HINT = "#868e96"


class TagDialog(QDialog):
    """给选中的一批切片打/去标签。

    **三态是重点**:多选时有的条目有这个标签、有的没有,那一栏必须是"半选"并
    保持不变——只有人主动点成全选/全不选,才算他要求"全部加上"/"全部去掉"。
    没有三态的话,打开对话框按一下确定就会把别人身上的标签抹掉。
    """

    def __init__(self, parent, targets: list[Slice], all_tags: list[str]):
        super().__init__(parent)
        self.setWindowTitle(f"给 {len(targets)} 条打标签")
        self.resize(340, 420)
        self._targets = targets

        v = QVBoxLayout(self)
        v.addWidget(QLabel("勾上＝全部加上，取消＝全部去掉，半选＝保持原样"))
        self.list = QListWidget()
        v.addWidget(self.list, 1)
        for tag in all_tags:
            have = sum(1 for s in targets if s.has_tag(tag))
            it = QListWidgetItem(tag)
            it.setFlags(it.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            it.setData(Qt.ItemDataRole.UserRole, tag)
            it.setCheckState(
                Qt.CheckState.Checked if have == len(targets)
                else Qt.CheckState.Unchecked if have == 0
                else Qt.CheckState.PartiallyChecked
            )
            self.list.addItem(it)

        row = QHBoxLayout()
        self.new_tag = QLineEdit()
        self.new_tag.setPlaceholderText("新标签…")
        self.new_tag.returnPressed.connect(self._add_tag)
        row.addWidget(self.new_tag, 1)
        btn = QPushButton("加入")
        btn.clicked.connect(self._add_tag)
        row.addWidget(btn)
        v.addLayout(row)

        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        v.addWidget(box)

    def _add_tag(self) -> None:
        tag = sanitize_tag(self.new_tag.text())
        if not tag:
            return
        for i in range(self.list.count()):
            if self.list.item(i).data(Qt.ItemDataRole.UserRole) == tag:
                self.list.item(i).setCheckState(Qt.CheckState.Checked)
                self.new_tag.clear()
                return
        it = QListWidgetItem(tag)
        it.setFlags(it.flags() | Qt.ItemFlag.ItemIsUserCheckable)
        it.setData(Qt.ItemDataRole.UserRole, tag)
        it.setCheckState(Qt.CheckState.Checked)
        self.list.addItem(it)
        self.new_tag.clear()

    def apply_to(self, sl: Slice) -> list[str]:
        """算出这条切片改完之后的标签列表(不改原对象)。"""
        tags = list(sl.tags)
        for i in range(self.list.count()):
            it = self.list.item(i)
            tag = str(it.data(Qt.ItemDataRole.UserRole))
            state = it.checkState()
            if state == Qt.CheckState.Checked and tag not in tags:
                tags.append(tag)
            elif state == Qt.CheckState.Unchecked and tag in tags:
                tags.remove(tag)
        return clean_tags(tags)


class _MaybeField(QWidget):
    """"改不改这一项"+ 值。批量面板里不带这个开关就没法表达"这项别动"。"""

    def __init__(self, label: str, editor: QWidget):
        super().__init__()
        h = QHBoxLayout(self)
        h.setContentsMargins(0, 0, 0, 0)
        self.check = QCheckBox(label)
        self.editor = editor
        editor.setEnabled(False)
        self.check.toggled.connect(editor.setEnabled)
        h.addWidget(self.check)
        h.addWidget(editor, 1)

    @property
    def wanted(self) -> bool:
        return self.check.isChecked()


class BatchParamsDialog(QDialog):
    """批量改逐条参数。没勾"改"的项一律不动——**默认什么都不改**。"""

    def __init__(self, parent, targets: list[Slice]):
        super().__init__(parent)
        self.setWindowTitle(f"批量改 {len(targets)} 条的参数")
        self._targets = targets
        v = QVBoxLayout(self)
        form = QFormLayout()
        form.setContentsMargins(4, 4, 4, 4)

        # **记住进来时的样子**：只有"你把它拨动了"才算要改。
        # 不记的话，一批条目本来都勾着，打开面板直接按确定也会把 enabled 写回去一遍——
        # 值虽然没变，但"我什么都没动"和"我确认全部产出"是两件事。
        self.produce = QCheckBox("作为产物导出")
        self.produce.setTristate(True)
        self._produce0 = _tri([s.enabled for s in targets])
        self.produce.setCheckState(self._produce0)
        self.produce.setToolTip("不动它＝保持原样。取消＝这些条目不再产出（底噪样本、废稿走这里）")
        form.addRow("产出", self.produce)

        self.denoise = QCheckBox("对这些条目降噪")
        self.denoise.setTristate(True)
        self._denoise0 = _tri([s.denoise for s in targets])
        self.denoise.setCheckState(self._denoise0)
        self.denoise.setToolTip("不动它＝保持原样。气声重的句子降噪会啃掉，单独关掉它")
        form.addRow("降噪", self.denoise)

        self.gain = _MaybeField("改增益", _spin(-24, 24, 1, " dB", _first(targets, "gain_db")))
        form.addRow("", self.gain)
        self.fade_in = _MaybeField("改淡入", _spin(0, 2, 3, " 秒", _first(targets, "fade_in_s")))
        form.addRow("", self.fade_in)
        self.fade_out = _MaybeField("改淡出", _spin(0, 2, 3, " 秒", _first(targets, "fade_out_s")))
        form.addRow("", self.fade_out)
        v.addLayout(form)

        tip = QLabel("改完这些条目会变成「已过时」——那是对的：盘上的产物确实还是旧参数渲的。")
        tip.setWordWrap(True)
        tip.setStyleSheet(f"color: {_HINT};")
        v.addWidget(tip)

        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        v.addWidget(box)

    def changes(self) -> dict:
        """要施加的改动。**没动过的项不出现在结果里**——打开面板直接按确定 = 什么都不改。"""
        out: dict = {}
        for field, box, initial in (
            ("enabled", self.produce, self._produce0),
            ("denoise", self.denoise, self._denoise0),
        ):
            state = box.checkState()
            if state != initial and state != Qt.CheckState.PartiallyChecked:
                out[field] = state == Qt.CheckState.Checked
        for field, widget in (
            ("gain_db", self.gain), ("fade_in_s", self.fade_in), ("fade_out_s", self.fade_out),
        ):
            if widget.wanted:
                out[field] = float(widget.editor.value())
        return out


def _tri(flags: list[bool]) -> Qt.CheckState:
    if all(flags):
        return Qt.CheckState.Checked
    if not any(flags):
        return Qt.CheckState.Unchecked
    return Qt.CheckState.PartiallyChecked


def _first(targets: list[Slice], attr: str) -> float:
    return float(getattr(targets[0], attr)) if targets else 0.0


def _spin(lo: float, hi: float, decimals: int, suffix: str, value: float) -> QDoubleSpinBox:
    s = QDoubleSpinBox()
    s.setRange(lo, hi)
    s.setDecimals(decimals)
    s.setSuffix(suffix)
    s.setSingleStep(0.5 if decimals <= 1 else 0.01)
    s.setValue(value)
    return s


def render_template(tpl: str, sl: Slice, index: int, start: int, width: int) -> str:
    """模板占位符 → 实际名字。占位符只有四个,多了没人记得住。"""
    return (
        str(tpl)
        .replace("{源}", Path(sl.source).stem)
        .replace("{名}", sl.name)
        .replace("{标签}", sl.tags[0] if sl.tags else "")
        .replace("{序}", str(start + index).zfill(max(1, width)))
    )


class RenameDialog(QDialog):
    """批量重命名:作用域 + 两种模式 + 实时预览。

    **为什么默认连带改名磁盘上的产物**:产物文件名就是 ``audio_config`` 里
    ``src`` 的最后一段。

    - 不连带:旧文件留在盘上、仍被引用、内容是旧的 → 游戏里放的还是旧声音,**静默错**;
    - 连带:引用悬垂 → 素材引用审计当场报"媒体引用不可解析" → **可见错**,去挂一下就好。

    宁可要可见的错。所以默认连带,并且在预览里把"已导出"的条目单独标出来:
    对它们来说改名是重构,不是打字。
    """

    def __init__(
        self,
        parent,
        scopes: list[tuple[str, list[Slice]]],
        *,
        all_slices: list[Slice],
        out_dir: Path,
        exported_ids: set[str],
    ):
        super().__init__(parent)
        self.setWindowTitle("批量重命名")
        self.resize(640, 520)
        self._scopes = [(label, items) for label, items in scopes if items]
        self._all = all_slices
        self._out_dir = Path(out_dir)
        self._exported = set(exported_ids)
        self._blocked = False

        v = QVBoxLayout(self)
        top = QHBoxLayout()
        top.addWidget(QLabel("作用于"))
        self.scope = QComboBox()
        for label, items in self._scopes:
            self.scope.addItem(f"{label}（{len(items)} 条）", label)
        top.addWidget(self.scope, 1)
        v.addLayout(top)

        mode = QGroupBox("怎么改")
        mv = QVBoxLayout(mode)
        self.by_template = QRadioButton("按模板")
        self.by_template.setChecked(True)
        mv.addWidget(self.by_template)
        tpl_row = QHBoxLayout()
        self.template = QLineEdit("{源}_{序}")
        self.template.setToolTip("占位符：{源}=源文件名  {名}=原产物名  {标签}=第一个标签  {序}=序号")
        tpl_row.addWidget(self.template, 1)
        tpl_row.addWidget(QLabel("起始"))
        self.start_at = QSpinBox()
        self.start_at.setRange(0, 9999)
        self.start_at.setValue(1)
        tpl_row.addWidget(self.start_at)
        tpl_row.addWidget(QLabel("位宽"))
        self.width = QSpinBox()
        self.width.setRange(1, 6)
        self.width.setValue(1)
        self.width.setToolTip("2 = 01、02…（排序时才不会 10 排在 2 前面）")
        tpl_row.addWidget(self.width)
        mv.addLayout(tpl_row)

        self.by_replace = QRadioButton("查找替换")
        mv.addWidget(self.by_replace)
        rep_row = QHBoxLayout()
        self.find = QLineEdit()
        self.find.setPlaceholderText("查找…")
        rep_row.addWidget(self.find, 1)
        self.repl = QLineEdit()
        self.repl.setPlaceholderText("替换为…")
        rep_row.addWidget(self.repl, 1)
        self.regex = QCheckBox("正则")
        rep_row.addWidget(self.regex)
        mv.addLayout(rep_row)
        v.addWidget(mode)

        self.preview = QTableWidget(0, 3)
        self.preview.setHorizontalHeaderLabels(["原名", "改成", "说明"])
        self.preview.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.preview.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.preview.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        v.addWidget(self.preview, 1)

        self.rename_files = QCheckBox("同时改名已导出的产物文件（推荐）")
        self.rename_files.setChecked(True)
        self.rename_files.setToolTip(
            "不改的话，盘上那个旧文件还被 audio_config 引用着，内容却是旧的——\n"
            "游戏里会继续放旧声音，而且没有任何地方报错。\n"
            "改了则引用悬垂，素材审计会当场报出来，去 audio_editor 重挂一下即可。"
        )
        v.addWidget(self.rename_files)
        self.summary = QLabel("")
        self.summary.setWordWrap(True)
        v.addWidget(self.summary)

        self.box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        self.box.accepted.connect(self.accept)
        self.box.rejected.connect(self.reject)
        v.addWidget(self.box)

        for w in (self.template, self.find, self.repl):
            w.textChanged.connect(self._refresh)
        for w in (self.start_at, self.width):
            w.valueChanged.connect(self._refresh)
        for w in (self.by_template, self.by_replace, self.regex):
            w.toggled.connect(self._refresh)
        self.scope.currentIndexChanged.connect(self._refresh)
        self._refresh()

    # ------------------------------------------------------------------ 计算

    def targets(self) -> list[Slice]:
        idx = max(0, self.scope.currentIndex())
        return self._scopes[idx][1] if self._scopes else []

    def _new_name(self, sl: Slice, i: int) -> str:
        if self.by_template.isChecked():
            return sanitize_name(
                render_template(self.template.text(), sl, i, self.start_at.value(), self.width.value())
            )
        find = self.find.text()
        if not find:
            return sl.name
        if self.regex.isChecked():
            try:
                return sanitize_name(re.sub(find, self.repl.text(), sl.name))
            except re.error:
                return sl.name
        return sanitize_name(sl.name.replace(find, self.repl.text()))

    def plan(self) -> list[tuple[Slice, str]]:
        """(切片, 新名);名字没变的条目不进计划——不改的东西不该被"改"一遍。"""
        out = []
        for i, sl in enumerate(self.targets()):
            new = self._new_name(sl, i)
            if new != sl.name:
                out.append((sl, new))
        return out

    def _refresh(self) -> None:
        targets = self.targets()
        plan = {sl.id: new for sl, new in self.plan()}
        # 改完之后全工程的名字分布:重名判定必须按"改完之后"算,不是按现状算
        after: dict[str, int] = {}
        for sl in self._all:
            after[plan.get(sl.id, sl.name)] = after.get(plan.get(sl.id, sl.name), 0) + 1

        self.preview.setRowCount(len(targets))
        bad = 0
        regex_broken = self.by_replace.isChecked() and self.regex.isChecked() and not _regex_ok(self.find.text())
        for row, sl in enumerate(targets):
            new = plan.get(sl.id, sl.name)
            note, color = self._note_for(sl, new, after)
            if color == _BAD:
                bad += 1
            for col, text in ((0, sl.name), (1, new), (2, note)):
                it = QTableWidgetItem(text)
                if col == 2 and color:
                    it.setForeground(Qt.GlobalColor.red if color == _BAD else Qt.GlobalColor.darkYellow)
                self.preview.setItem(row, col, it)
        self.preview.resizeColumnToContents(0)
        self.preview.resizeColumnToContents(1)

        self._blocked = bad > 0 or regex_broken
        self.box.button(QDialogButtonBox.StandardButton.Ok).setEnabled(
            not self._blocked and bool(plan)
        )
        if regex_broken:
            self.summary.setText("正则写错了，改对了才能继续。")
            self.summary.setStyleSheet(f"color: {_BAD};")
        elif bad:
            self.summary.setText(f"{bad} 条有冲突（红色那几行），改完才能继续。")
            self.summary.setStyleSheet(f"color: {_BAD};")
        else:
            n_exported = sum(1 for sl, _ in self.plan() if sl.id in self._exported)
            self.summary.setText(
                f"将改名 {len(plan)} 条"
                + (f"，其中 {n_exported} 条已经导出过（那是重构，不是打字）" if n_exported else "")
            )
            self.summary.setStyleSheet(f"color: {_HINT};")

    def _note_for(self, sl: Slice, new: str, after: dict[str, int]) -> tuple[str, str]:
        if new == sl.name:
            return ("不变", "")
        if after.get(new, 0) > 1:
            return ("和别的切片重名了", _BAD)
        dest = self._out_dir / f"{new}.wav"
        if dest.exists():
            return ("导出目录里已经有这个文件了（不会覆盖它）", _WARN)
        if sl.id in self._exported:
            return ("已导出：连带改名，audio_config 里的引用会断，需要重挂", _WARN)
        return ("还没导出过，改名零成本", "")

    def wants_file_rename(self) -> bool:
        return self.rename_files.isChecked()


def _regex_ok(pattern: str) -> bool:
    if not pattern:
        return True
    try:
        re.compile(pattern)
    except re.error:
        return False
    return True
