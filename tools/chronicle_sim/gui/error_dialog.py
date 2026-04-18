"""统一错误弹窗：避免主文案为空或详情全藏在「显示详细信息」里看不见。"""
from __future__ import annotations

import httpx
from PySide6.QtWidgets import QMessageBox, QWidget

from tools.chronicle_sim.gui.console_errors import log_async_failure_dialog


def exc_human(exc: BaseException) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return (
            f"{type(exc).__qualname__}: HTTP 等待超时。"
            "可在「配置 → 代理」中增大「对话/嵌入 HTTP 读超时（秒）」，或检查网络与模型推理是否过慢。"
        )
    name = type(exc).__qualname__
    msg = (str(exc) or "").strip()
    if msg:
        return f"{name}: {msg}"
    return f"{name}（无具体说明，常见于网络中断、超时或底层库未返回文本）"


def normalize_async_summary(summary: str, detail: str) -> tuple[str, str]:
    s = (summary or "").strip()
    d = (detail or "").strip()
    if not s and d:
        first = next((ln.strip() for ln in d.splitlines() if ln.strip()), "")
        if first:
            s = first[:400]
    if not s:
        s = "发生错误，但未收到可用摘要。请查看下方说明或「显示详细信息」。"
    return s, d


def show_async_failure(parent: QWidget | None, window_title: str, summary: str, detail: str) -> None:
    s, d = normalize_async_summary(summary, detail)
    log_async_failure_dialog(window_title, s, d)
    box = QMessageBox(parent)
    box.setIcon(QMessageBox.Icon.Critical)
    box.setWindowTitle(window_title)
    box.setText(s)
    if d:
        lines = [ln for ln in d.strip().splitlines() if ln.strip()]
        head = "\n".join(lines[:12])
        if len(lines) > 12:
            head += "\n…"
        box.setInformativeText("堆栈摘要（完整内容在「显示详细信息」）：\n" + head)
        box.setDetailedText(d)
    else:
        box.setInformativeText("无 Python 堆栈。请查看主窗口底部「活动日志」。")
    box.exec()


def nonempty_information(parent: QWidget | None, title: str, body: str, *, empty_fallback: str) -> None:
    text = (body or "").strip() or empty_fallback
    QMessageBox.information(parent, title, text)
