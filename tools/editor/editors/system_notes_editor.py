"""教程/首次死亡说明卡。模型暂存与 Save All 写盘；不直接写 JSON。"""
from copy import deepcopy
import re
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QWidget, QHBoxLayout, QVBoxLayout, QFormLayout, QListWidget, QPushButton, QLineEdit, QComboBox, QScrollArea, QSplitter, QMessageBox
from ..shared.form_layout import compact_form
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.id_ref_selector import IdRefSelector
from ..shared import confirm
from ..shared.list_affordances import wire_list_affordances


def note_usages(model, note_id):
    """说明卡引用 + 已读条件；删除/改名之前同一口径检查。"""
    from ..shared.prop_preset_refs import _project_nodes
    found = set()
    def walk(node, where):
        if isinstance(node, dict):
            params = node.get("params")
            if isinstance(params, dict):
                key = "noteId" if node.get("type") == "showSystemNote" else "deathNoteId" if node.get("type") == "inflictHealthDamage" else None
                if key and params.get(key) == note_id:
                    found.add(where)
            threat = node.get("healthThreat")
            if isinstance(threat, dict) and threat.get("deathNoteId") == note_id:
                found.add(where)
            retry = node.get("retry")
            if isinstance(retry, dict) and retry.get("firstDeathNoteId") == note_id:
                found.add(where)
            if node.get("flag") == f"sysnote_{note_id}":
                found.add(where)
            for value in node.values():
                walk(value, where)
        elif isinstance(node, list):
            for value in node:
                walk(value, where)
    for where, _, node in _project_nodes(model):
        walk(node, where)
    return sorted(found)


class SystemNotesEditor(QWidget):
    def __init__(self, model, parent=None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1
        self._original = {}
        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal, self)
        root.addWidget(splitter)
        left = QWidget(splitter)
        ll = QVBoxLayout(left)
        buttons = QHBoxLayout()
        for title, handler in (("新增说明卡", self._add), ("删除", self._delete)):
            button = QPushButton(title, left)
            button.clicked.connect(handler)
            buttons.addWidget(button)
        ll.addLayout(buttons)
        self._list = QListWidget(left)
        ll.addWidget(self._list)
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除说明卡")
        scroll = QScrollArea(splitter)
        scroll.setWidgetResizable(True)
        self._body_host = QWidget(scroll)
        layout = QVBoxLayout(self._body_host)
        form = compact_form(QFormLayout())
        self._id = QLineEdit(self._body_host)
        self._title = RichTextLineEdit(model, self._body_host)
        self._body = RichTextTextEdit(model, self._body_host)
        self._body.setMinimumHeight(200)
        self._image = CutsceneImagePathRow(model, "", self._body_host, external_copy_subdir="ui", path_edit_read_only=True)
        self._lore = IdRefSelector(self._body_host, allow_empty=True, editable=False, click_opens_popup=True)
        self._anchor = QComboBox(self._body_host)
        for key, label in (("", "无留白"), ("threeFires", "三把火"), ("smell", "气味指示器")):
            self._anchor.addItem(label, key)
        for label, widget in (("说明卡 id", self._id), ("标题", self._title), ("正文", self._body),
                              ("配图（可空）", self._image), ("对应见闻录（可空）", self._lore), ("压暗时保留的 HUD", self._anchor)):
            form.addRow(label, widget)
        layout.addLayout(form)
        apply = QPushButton("应用到工程", self._body_host)
        apply.clicked.connect(self.flush_to_model)
        layout.addWidget(apply)
        layout.addStretch()
        scroll.setWidget(self._body_host)
        splitter.setSizes([260, 740])
        self._refresh()

    def _rows(self):
        return self._model.system_note_rows()

    def _refresh(self, select_id=""):
        self._current_idx = -1
        self._list.blockSignals(True)
        self._list.clear()
        for note in self._rows():
            self._list.addItem(f"{note.get('id', '?')}  {note.get('title', '')}")
        self._list.blockSignals(False)
        self._body_host.setEnabled(False)
        if select_id:
            self.select_by_id(select_id)
        elif self._rows():
            self._list.setCurrentRow(0)

    def reload_from_model(self):
        self._refresh(str(self._original.get("id", "")))

    def reload_refs_from_model(self):
        current = self._lore.current_id()
        lore = self._model.archive_lore
        rows = lore.get("entries", []) if isinstance(lore, dict) else lore if isinstance(lore, list) else []
        self._lore.set_items([(str(n.get("id", "")), str(n.get("title", n.get("id", "")))) for n in rows if isinstance(n, dict)])
        self._lore.set_current(current)

    def select_by_id(self, item_id, _scene_id=""):
        for index, note in enumerate(self._rows()):
            if note.get("id") == item_id:
                self._list.setCurrentRow(index)
                return True
        return False

    def _on_select(self, index):
        if index == self._current_idx:
            return
        if not self.flush_to_model():
            self._list.blockSignals(True)
            self._list.setCurrentRow(self._current_idx)
            self._list.blockSignals(False)
            return
        self._current_idx = index if 0 <= index < len(self._rows()) else -1
        self._load_current()

    def _load_current(self):
        if self._current_idx < 0:
            self._body_host.setEnabled(False)
            return
        self._original = deepcopy(self._rows()[self._current_idx])
        note = self._original
        self._id.setText(str(note.get("id", "")))
        self._title.setText(str(note.get("title", "")))
        self._body.setPlainText(str(note.get("body", "")))
        self._image.set_path(str(note.get("image", "")))
        self.reload_refs_from_model()
        self._lore.set_current(str(note.get("loreEntryId", "")))
        anchor = note.get("hudAnchor", "")
        index = self._anchor.findData(anchor)
        if index < 0:
            self._anchor.addItem(f"（数据）{anchor}", anchor)
            index = self._anchor.count() - 1
        self._anchor.setCurrentIndex(index)
        self._body_host.setEnabled(True)

    def _value(self):
        note = deepcopy(self._original)
        note.update(id=self._id.text().strip(), title=self._title.text(), body=self._body.toPlainText())
        for key, value in (("image", self._image.path()), ("loreEntryId", self._lore.current_id()), ("hudAnchor", self._anchor.currentData())):
            if value or self._original.get(key) == "":
                note[key] = value
            else:
                note.pop(key, None)
        return note

    def _is_dirty(self):
        return self._current_idx >= 0 and self._value() != self._original

    def flush_to_model(self):
        if not self._is_dirty():
            return True
        note = self._value()
        error = ""
        if not re.fullmatch(r"[A-Za-z0-9_-]+", note["id"]) or not note["title"].strip() or not note["body"].strip():
            error = "id 只能含英文字母、数字、下划线或连字符；标题和正文不能为空。"
        elif any(index != self._current_idx and row.get("id") == note["id"] for index, row in enumerate(self._rows())):
            error = "这个说明卡 id 已存在。"
        elif note["id"] != self._original.get("id"):
            usages = note_usages(self._model, self._original.get("id", ""))
            if usages:
                error = "该 id 仍被引用，请先调整引用再改名：\n" + "\n".join(usages)
        if error:
            QMessageBox.warning(self, "说明卡尚未应用", error)
            return False
        row = self._rows()[self._current_idx]
        row.clear()
        row.update(note)
        self._original = deepcopy(note)
        self._list.item(self._current_idx).setText(f"{note['id']}  {note['title']}")
        self._model.mark_dirty("system_notes")
        return True

    def commit_pending_on_leave(self):
        return self.flush_to_model()

    def confirm_close(self, parent=None):
        if not self._is_dirty():
            return True
        buttons = QMessageBox.StandardButton
        answer = QMessageBox.question(parent or self, "未应用的修改", "保存当前说明卡的修改？", buttons.Save | buttons.Discard | buttons.Cancel)
        if answer == buttons.Cancel:
            return False
        if answer == buttons.Save:
            return self.flush_to_model()
        self._load_current()
        return True

    def _add(self):
        if not self.flush_to_model():
            return
        raw = self._model.system_notes
        if isinstance(raw, list):
            rows = raw
        else:
            if not isinstance(raw, dict):
                raw = {}; self._model.system_notes = raw
            rows = raw.setdefault("notes", [])
        taken = {row.get("id") for row in rows}
        number = 1
        while f"note_{number}" in taken:
            number += 1
        key = f"note_{number}"
        rows.append({"id": key, "title": "新说明卡", "body": "在此填写说明。"})
        self._model.mark_dirty("system_notes")
        self._refresh(key)

    def _delete(self):
        if self._current_idx < 0 or not self.flush_to_model():
            return
        key = self._original["id"]
        usages = note_usages(self._model, key)
        if usages:
            QMessageBox.warning(self, "说明卡仍在使用", "请先移除以下引用：\n" + "\n".join(usages))
            return
        if not confirm.confirm_delete(self, f"说明卡「{key}」"):
            return
        raw = self._model.system_notes
        rows = raw if isinstance(raw, list) else raw["notes"]
        rows[:] = [note for note in rows if note.get("id") != key]
        self._model.mark_dirty("system_notes")
        self._refresh()
