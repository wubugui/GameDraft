"""统一的"删除确认"对话框。

各编辑器删除昂贵/不可撤销的顶层实体前一律走这里,既补齐缺失的确认(数据不会被一键
误删),又消除各编辑器自造确认文案不一致的问题。返回 True 表示用户确认删除。

测试可通过 `unittest.mock.patch('tools.editor.shared.confirm.confirm_delete', ...)`
绕过弹窗(编辑器以 `confirm.confirm_delete(...)` 形式调用,运行时按属性查找,patch 生效)。
"""
from __future__ import annotations

from PySide6.QtWidgets import QMessageBox, QWidget


def confirm_delete(parent: QWidget | None, what: str, detail: str = "") -> bool:
    """删除前确认。what 为对删除对象的简短描述(如 '该场景实体 npc_zhang')。"""
    msg = f"确定删除{what}吗？此操作不可撤销。"
    if detail:
        msg += f"\n{detail}"
    r = QMessageBox.question(
        parent,
        "确认删除",
        msg,
        QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        QMessageBox.StandardButton.No,
    )
    return r == QMessageBox.StandardButton.Yes
