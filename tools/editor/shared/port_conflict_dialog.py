"""游戏开发服务器端口冲突弹窗。

vite 是 strictPort(5173 被占就起不来，见 vite.config.ts server 注释)，多 worktree /
残留 node 进程并行时端口冲突是常态。本窗把「谁占着端口、是谁启动的」摆给用户，
由用户二选一：结束占用进程后继续启动，或取消本次启动。

只负责展示与选择；探测(:mod:`tools.dev.game` 的 ``describe_port_occupants``)与
真正的杀进程/重启动作都在调用方(main_window)手里——弹窗自己不碰进程。
"""
from __future__ import annotations

import os

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication, QDialog, QHBoxLayout, QLabel, QPushButton, QTextEdit,
    QVBoxLayout,
)

# 不允许从弹窗发起结束的 PID：0/4 是 Windows 的 Idle/System，杀了等于要求关机；
# 自身 PID 理论到不了这里(编辑器不监听 5173)，防御性拦一道。
_PROTECTED_PIDS = {0, 4}


def _occupant_text(occ) -> str:
    """单个占用者的多行描述(占位符如实标「取不到」，不猜)。"""
    lines = [f"端口 {occ.port} · PID {occ.pid} · {occ.name or '(进程名取不到)'}"]
    lines.append(f"  启动命令: {occ.cmdline or '(取不到)'}")
    lines.append(f"  启动用户: {occ.username or '(取不到)'}")
    lines.append(f"  启动时间: {occ.started_at or '(取不到)'}")
    if occ.parent_chain:
        lines.append("  父进程链: " + " ← ".join(occ.parent_chain))
    else:
        lines.append("  父进程链: (取不到)")
    if occ.detail_error:
        lines.append(f"  ⚠ {occ.detail_error}")
    return "\n".join(lines)


class PortConflictDialog(QDialog):
    """展示端口占用详情；Accepted = 用户选择「结束占用进程并继续启动」。"""

    def __init__(self, port: int, occupants: list, parent=None) -> None:
        super().__init__(parent)
        self._occupants = list(occupants)
        self.setWindowTitle("端口冲突")
        self.setModal(True)
        self.resize(720, 380)

        root = QVBoxLayout(self)
        head = QLabel(
            f"端口 {port} 已被占用，游戏开发服务器无法启动。\n"
            "占用详情如下——可结束占用进程后继续启动，或取消本次启动。"
        )
        head.setWordWrap(True)
        head.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        root.addWidget(head)

        detail = QTextEdit()
        detail.setReadOnly(True)
        detail.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        self._detail_text = "\n\n".join(_occupant_text(o) for o in self._occupants)
        detail.setPlainText(self._detail_text)
        root.addWidget(detail, 1)

        btn_row = QHBoxLayout()
        copy_btn = QPushButton("复制详情")
        copy_btn.clicked.connect(self._copy_details)
        btn_row.addWidget(copy_btn)
        btn_row.addStretch(1)

        self._kill_btn = QPushButton("结束占用进程并启动游戏")
        self._kill_btn.clicked.connect(self.accept)
        cancel_btn = QPushButton("取消启动")
        cancel_btn.clicked.connect(self.reject)
        # 杀进程不可逆：默认焦点给「取消」，回车不误杀
        cancel_btn.setDefault(True)
        self._kill_btn.setAutoDefault(False)
        btn_row.addWidget(self._kill_btn)
        btn_row.addWidget(cancel_btn)
        root.addLayout(btn_row)

        blocked = [
            o for o in self._occupants
            if o.pid in _PROTECTED_PIDS or o.pid == os.getpid()
        ]
        if blocked:
            self._kill_btn.setEnabled(False)
            self._kill_btn.setToolTip(
                "占用者包含系统进程或编辑器自身"
                f"(PID {', '.join(str(o.pid) for o in blocked)})，"
                "不能从这里结束；请手动排查。"
            )

    def _copy_details(self) -> None:
        clipboard = QApplication.clipboard()
        if clipboard is not None:
            clipboard.setText(self._detail_text)
