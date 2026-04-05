"""Flag key UI: only values from flag_registry expansion (no free typing)."""
from __future__ import annotations

from PySide6.QtWidgets import QComboBox

FLAG_PLACEHOLDER = "— 选择 flag —"


def populate_flag_key_combo(combo: QComboBox, allowed: list[str], current: str) -> None:
    """Non-editable combo: placeholder, sorted allowed keys, optional legacy invalid row."""
    combo.blockSignals(True)
    combo.clear()
    combo.addItem(FLAG_PLACEHOLDER, "")
    seen: set[str] = set()
    for k in sorted(allowed):
        if not k or k in seen:
            continue
        seen.add(k)
        combo.addItem(k, k)
    if current and current not in seen:
        combo.insertItem(1, f"「未登记」 {current}", current)
        combo.setCurrentIndex(1)
    elif current:
        idx = combo.findData(current)
        combo.setCurrentIndex(idx if idx >= 0 else 0)
    else:
        combo.setCurrentIndex(0)
    combo.blockSignals(False)
