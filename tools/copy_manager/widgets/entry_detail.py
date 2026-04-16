"""Detail panel: shows editable source text, metadata, notes editor, and translation inputs."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from tools.copy_manager.constants import CONTEXT_TEMPLATES, FILE_TYPE_LABELS, STATUSES


class EntryDetailPanel(QWidget):
    """Right-side detail panel for a selected entry."""

    # Signals for saving changes
    notes_changed = Signal(str, str)  # (uid, new_notes)
    status_changed = Signal(str, str)  # (uid, new_status)
    translation_changed = Signal(str, str, str)  # (uid, lang, new_text)
    language_added = Signal(str, str)  # (uid, lang_code)
    source_changed = Signal(str, str)  # (uid, new_source_text)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._current_uid: str | None = None
        self._languages: list[str] = ["en", "ja"]
        self._source_dirty = False
        self._notes_connected = False
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(12)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        inner = QWidget()
        inner_layout = QVBoxLayout(inner)
        inner_layout.setSpacing(12)

        # Source text section (editable)
        source_group = QGroupBox("原文")
        source_layout = QVBoxLayout(source_group)

        self.source_text = QPlainTextEdit()
        self.source_text.setMinimumHeight(100)
        self.source_text.setStyleSheet("QPlainTextEdit { font-size: 14px; }")
        self.source_text.textChanged.connect(self._on_source_change)
        source_layout.addWidget(self.source_text)

        # Source action bar
        source_action_bar = QHBoxLayout()
        self.edit_source_btn = QPushButton("编辑")
        self.edit_source_btn.setFixedWidth(60)
        self.edit_source_btn.clicked.connect(self._toggle_edit_source)
        source_action_bar.addWidget(self.edit_source_btn)

        self.save_source_btn = QPushButton("保存修改")
        self.save_source_btn.setFixedWidth(80)
        self.save_source_btn.setVisible(False)
        self.save_source_btn.setEnabled(False)
        self.save_source_btn.clicked.connect(self._save_source)
        source_action_bar.addWidget(self.save_source_btn)

        source_action_bar.addStretch()
        source_layout.addLayout(source_action_bar)
        inner_layout.addWidget(source_group)

        # Metadata
        meta_group = QGroupBox("元数据")
        meta_layout = QVBoxLayout(meta_group)
        self.file_label = QLabel("文件: —")
        self.field_label = QLabel("字段: —")
        self.type_label = QLabel("类型: —")
        self.tags_label = QLabel("标签: —")
        self.file_label.setWordWrap(True)
        self.field_label.setWordWrap(True)
        self.tags_label.setWordWrap(True)
        for lbl in (self.file_label, self.field_label, self.type_label, self.tags_label):
            lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
            meta_layout.addWidget(lbl)
        inner_layout.addWidget(meta_group)

        # Context notes
        notes_group = QGroupBox("备注 / 说明")
        notes_layout = QVBoxLayout(notes_group)
        self.notes_editor = QPlainTextEdit()
        self.notes_editor.setMinimumHeight(80)
        self.notes_editor.setPlaceholderText("描述这条文案的用途、语境、翻译注意事项...")
        notes_layout.addWidget(self.notes_editor)

        # Template dropdown
        template_layout = QHBoxLayout()
        self.template_combo = QComboBox()
        self.template_combo.addItem("应用上下文模板...")
        for ft, tmpl in CONTEXT_TEMPLATES.items():
            self.template_combo.addItem(FILE_TYPE_LABELS.get(ft, ft), ft)
        self.template_combo.currentIndexChanged.connect(self._on_apply_template)
        template_layout.addWidget(self.template_combo)
        notes_layout.addLayout(template_layout)
        inner_layout.addWidget(notes_group)

        # Status
        status_layout = QHBoxLayout()
        status_layout.addWidget(QLabel("状态:"))
        self.status_combo = QComboBox()
        for s in STATUSES:
            self.status_combo.addItem(s, s)
        self.status_combo.currentIndexChanged.connect(self._on_status_change)
        status_layout.addWidget(self.status_combo)
        inner_layout.addLayout(status_layout)

        # Translations
        trans_group = QGroupBox("翻译")
        trans_layout = QVBoxLayout(trans_group)
        self.trans_editors: dict[str, QLineEdit] = {}
        for lang in self._languages:
            row = QHBoxLayout()
            row.addWidget(QLabel(f"{lang}:"), 0)
            editor = QLineEdit()
            editor.setPlaceholderText(f"翻译到 {lang}...")
            editor.editingFinished.connect(
                lambda l=lang, e=editor: self._on_translation(l, e.text())
            )
            row.addWidget(editor, 1)
            trans_layout.addLayout(row)
            self.trans_editors[lang] = editor

        # Add language
        add_lang_layout = QHBoxLayout()
        self.lang_input = QLineEdit()
        self.lang_input.setPlaceholderText("语言代码 (如 ko, fr)")
        self.lang_input.setMaximumWidth(120)
        self.add_lang_btn = QPushButton("+ 添加")
        self.add_lang_btn.clicked.connect(self._add_language)
        add_lang_layout.addWidget(self.lang_input)
        add_lang_layout.addWidget(self.add_lang_btn)
        add_lang_layout.addStretch()
        trans_layout.addLayout(add_lang_layout)

        inner_layout.addWidget(trans_group)
        inner_layout.addStretch()

        scroll.setWidget(inner)
        layout.addWidget(scroll)

    def _toggle_edit_source(self) -> None:
        """Toggle source text between read-only and editable mode."""
        is_read_only = self.source_text.isReadOnly()
        self.source_text.setReadOnly(not is_read_only)
        if is_read_only:
            self.edit_source_btn.setText("锁定")
            self.save_source_btn.setVisible(True)
        else:
            self.edit_source_btn.setText("编辑")
            self.save_source_btn.setVisible(False)
            self._source_dirty = False
            # Reset to original
            if self._current_uid:
                self.source_text.blockSignals(True)
                self.source_text.setPlainText(self._original_source_text)
                self.source_text.blockSignals(False)

    def _on_source_change(self) -> None:
        if not self.source_text.isReadOnly():
            self._source_dirty = True
            self.save_source_btn.setEnabled(
                self.source_text.toPlainText() != self._original_source_text
            )

    def _save_source(self) -> None:
        if self._current_uid and self._source_dirty:
            new_text = self.source_text.toPlainText()
            self.source_changed.emit(self._current_uid, new_text)
            self._original_source_text = new_text
            self._source_dirty = False
            self.save_source_btn.setEnabled(False)

    def load_entry(self, entry: dict | None) -> None:
        """Load an entry into the panel. Pass None to clear."""
        # Save pending source changes before switching
        if self._current_uid and self._source_dirty:
            self._save_source()

        if not entry:
            self.source_text.clear()
            self.file_label.setText("文件: —")
            self.field_label.setText("字段: —")
            self.type_label.setText("类型: —")
            self.tags_label.setText("标签: —")
            self.notes_editor.clear()
            self._current_uid = None
            for editor in self.trans_editors.values():
                editor.clear()
            self.source_text.setReadOnly(True)
            self.edit_source_btn.setText("编辑")
            self.save_source_btn.setVisible(False)
            self._source_dirty = False
            return

        self._current_uid = entry.get("uid", "")
        self._original_source_text = entry.get("source_text", "")

        # Reset to read-only mode
        self.source_text.blockSignals(True)
        self.source_text.setPlainText(self._original_source_text)
        self.source_text.setReadOnly(True)
        self.source_text.blockSignals(False)
        self.edit_source_btn.setText("编辑")
        self.save_source_btn.setVisible(False)
        self._source_dirty = False

        self.file_label.setText(f"文件: {entry.get('file_path', '')}")
        self.field_label.setText(f"字段: {entry.get('field_path', '')}")
        ft = entry.get("file_type", "")
        self.type_label.setText(f"类型: {FILE_TYPE_LABELS.get(ft, ft)}")

        tags = entry.get("tags", [])
        self.tags_label.setText(f"标签: {', '.join(tags)}" if tags else "标签: —")

        self.notes_editor.blockSignals(True)
        self.notes_editor.setPlainText(entry.get("context_notes", ""))
        self.notes_editor.blockSignals(False)
        # Reconnect notes signal
        if self._notes_connected:
            self.notes_editor.textChanged.disconnect(self._on_notes_change)
        self.notes_editor.textChanged.connect(self._on_notes_change)
        self._notes_connected = True

        # Set status without triggering callback
        self.status_combo.blockSignals(True)
        status = entry.get("status", "pending")
        idx = self.status_combo.findData(status)
        if idx >= 0:
            self.status_combo.setCurrentIndex(idx)
        self.status_combo.blockSignals(False)

        # Set translations
        translations = entry.get("translations", {})
        for lang, editor in self.trans_editors.items():
            editor.blockSignals(True)
            editor.setText(translations.get(lang, ""))
            editor.blockSignals(False)

    def set_languages(self, languages: list[str]) -> None:
        """Update the list of translation languages."""
        for lang in languages:
            if lang not in self.trans_editors:
                self._add_lang_editor(lang)
        self._languages = languages

    def _add_language(self) -> None:
        lang = self.lang_input.text().strip().lower()
        if not lang or lang in self.trans_editors:
            self.lang_input.clear()
            return
        self._add_lang_editor(lang)
        self._languages.append(lang)
        self.lang_input.clear()
        if self._current_uid:
            self.language_added.emit(self._current_uid, lang)

    def _add_lang_editor(self, lang: str) -> None:
        trans_group = self.findChild(QGroupBox, "翻译")
        if not trans_group:
            return
        layout = trans_group.layout()
        editor = QLineEdit()
        editor.setPlaceholderText(f"翻译到 {lang}...")
        editor.editingFinished.connect(
            lambda l=lang, e=editor: self._on_translation(l, e.text())
        )
        row = QHBoxLayout()
        row.addWidget(QLabel(f"{lang}:"), 0)
        row.addWidget(editor, 1)
        layout.insertLayout(layout.count() - 1, row)
        self.trans_editors[lang] = editor

    def _on_notes_change(self) -> None:
        if self._current_uid:
            self.notes_changed.emit(self._current_uid, self.notes_editor.toPlainText())

    def _on_status_change(self) -> None:
        if self._current_uid:
            status = self.status_combo.currentData()
            self.status_changed.emit(self._current_uid, status)

    def _on_translation(self, lang: str, text: str) -> None:
        if self._current_uid:
            self.translation_changed.emit(self._current_uid, lang, text)

    def _on_apply_template(self, index: int) -> None:
        if index <= 0 or not self._current_uid:
            return
        ft = self.template_combo.itemData(index)
        template = CONTEXT_TEMPLATES.get(ft, "")
        if self._current_uid:
            tags_str = " ".join(self.tags_label.text().replace("标签: ", "").split(", "))
            template = template.replace("{speaker}", "").replace("{knot}", "")
        self.notes_editor.insertPlainText(template)
        self.template_combo.setCurrentIndex(0)
