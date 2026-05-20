"""Shared Qt WebEngine page that drops known-benign Chromium console noise."""
from __future__ import annotations

_RESIZE_OBSERVER_NOISE = "ResizeObserver loop"


try:
    from PySide6.QtWebEngineCore import QWebEnginePage
except ImportError:  # pragma: no cover
    QWebEnginePage = None  # type: ignore[assignment,misc]


if QWebEnginePage is not None:

    class QuietWebEnginePage(QWebEnginePage):
        """Suppress ResizeObserver loop spam forwarded as `js:` lines in the editor log."""

        def javaScriptConsoleMessage(
            self,
            level,
            message: str,
            line_number: int,
            source_id: str,
        ) -> None:
            if message and _RESIZE_OBSERVER_NOISE in message:
                return
            super().javaScriptConsoleMessage(level, message, line_number, source_id)

else:  # pragma: no cover

    class QuietWebEnginePage:  # type: ignore[no-redef]
        pass
