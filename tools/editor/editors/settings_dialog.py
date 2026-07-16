"""编辑器设置对话框:外观(主题风格 + 字体大小)。

改动即时预览(直接作用到 QApplication),「确定」持久化到 QSettings,
「取消」回滚到打开前的外观。主题/字体的存取与应用统一走 theme 模块。
"""
from __future__ import annotations

from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QLabel,
    QSpinBox,
    QVBoxLayout,
)

from .. import theme

_THEME_CHOICES: list[tuple[str, str]] = [
    (theme.THEME_LIGHT, "浅色主题"),
    (theme.THEME_DARK, "黑色主题"),
    (theme.THEME_MODERN, "现代清爽 (类 VS Code)"),
]


class EditorSettingsDialog(QDialog):
    """外观设置:编辑器风格 + 全局字体大小。"""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("编辑器设置")
        self.setModal(True)
        self.setMinimumWidth(360)

        self._orig_theme = theme.current_theme_id()
        self._orig_font_px = theme.current_font_px()

        root = QVBoxLayout(self)

        appearance = QGroupBox("外观")
        from ..shared.form_layout import compact_form
        form = compact_form(QFormLayout(appearance))

        self._theme_combo = QComboBox()
        for tid, label in _THEME_CHOICES:
            self._theme_combo.addItem(label, tid)
        idx = self._theme_combo.findData(self._orig_theme)
        if idx >= 0:
            self._theme_combo.setCurrentIndex(idx)
        self._theme_combo.setToolTip("切换编辑器整体配色风格")
        self._theme_combo.currentIndexChanged.connect(self._preview)
        form.addRow("编辑器风格", self._theme_combo)

        self._font_spin = QSpinBox()
        self._font_spin.setRange(theme.MIN_FONT_PX, theme.MAX_FONT_PX)
        self._font_spin.setValue(self._orig_font_px)
        self._font_spin.setSuffix(" px")
        self._font_spin.setToolTip("全局基准字号;小屏可调小以减少留白与占用")
        self._font_spin.valueChanged.connect(self._preview)
        form.addRow("字体大小", self._font_spin)

        root.addWidget(appearance)

        hint = QLabel("改动即时预览;「取消」恢复打开前的外观。")
        hint.setWordWrap(True)
        hint.setStyleSheet(theme.secondary_label_stylesheet(self._orig_theme))
        root.addWidget(hint)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        root.addWidget(btns)

    # ---- helpers ----------------------------------------------------------
    def _selected_theme(self) -> str:
        data = self._theme_combo.currentData()
        return data if data in theme.ALL_THEME_IDS else self._orig_theme

    def _apply_appearance(self, theme_id: str, font_px: int) -> None:
        app = QApplication.instance()
        if app is not None:
            theme.apply_application_theme(app, theme_id, font_px)
        mw = self.parent()
        notify = getattr(mw, "on_appearance_changed", None)
        if callable(notify):
            notify()

    # ---- slots ------------------------------------------------------------
    def _preview(self, *_args) -> None:
        self._apply_appearance(self._selected_theme(), self._font_spin.value())

    def reject(self) -> None:  # noqa: N802 — Qt API
        self._apply_appearance(self._orig_theme, self._orig_font_px)
        super().reject()

    def accept(self) -> None:  # noqa: N802 — Qt API
        theme.settings_save_theme(self._selected_theme())
        theme.settings_save_font_px(self._font_spin.value())
        super().accept()
