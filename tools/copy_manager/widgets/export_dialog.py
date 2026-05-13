"""Export dialog: choose language and export options."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QLabel,
    QVBoxLayout,
)

from tools.copy_manager.constants import CATEGORY_LABELS


class ExportDialog(QDialog):
    """Dialog for configuring translation export."""

    def __init__(self, parent=None, languages: list[str] | None = None):
        super().__init__(parent)
        self.setWindowTitle("导出翻译")
        self.setMinimumWidth(400)
        self.selected_language = ""
        self.output_dir = ""
        self._init_ui(languages or [])

    def _init_ui(self, languages: list[str]) -> None:
        layout = QVBoxLayout(self)

        form = QFormLayout()

        # Language selector
        self.lang_combo = QComboBox()
        for lang in languages:
            self.lang_combo.addItem(lang, lang)
        self.lang_combo.addItem("自定义...")
        form.addRow("目标语言:", self.lang_combo)

        # Output directory hint
        self.dir_label = QLabel("将导出到 public/assets/data/{lang}/ 目录")
        self.dir_label.setWordWrap(True)
        form.addRow("输出目录:", self.dir_label)

        layout.addLayout(form)

        # Category checkboxes
        categories_group = QLabel("导出范围 (留空表示全部):")
        layout.addWidget(categories_group)
        self.category_checks: dict[str, QCheckBox] = {}
        for key, label in sorted(CATEGORY_LABELS.items()):
            cb = QCheckBox(label)
            cb.setChecked(True)
            self.category_checks[key] = cb
            layout.addWidget(cb)

        # Buttons
        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel
        )
        buttons.accepted.connect(self._accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self.lang_combo.currentIndexChanged.connect(self._on_lang_change)

    def _on_lang_change(self) -> None:
        lang = self.lang_combo.currentData()
        if lang == "custom":
            lang, ok = QFileDialog.getExistingDirectory(
                self, "选择输出目录"
            ), True
        self.dir_label.setText(f"将导出到 public/assets/data/{lang}/ 目录")

    def _accept(self) -> None:
        self.selected_language = self.lang_combo.currentData() or ""
        self.accept()

    def get_selected_categories(self) -> list[str]:
        return [
            key for key, cb in self.category_checks.items() if cb.isChecked()
        ]
