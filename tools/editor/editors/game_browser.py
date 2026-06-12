"""Embedded WebEngine panel for running the Vite dev game inside the editor."""
from __future__ import annotations

import html
import os
import sys
from pathlib import Path

from PySide6.QtCore import Qt, Signal, QUrl, QSize, QTimer, QEventLoop, QStandardPaths
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QLineEdit, QStyle, QSizePolicy,
)

# Default must match vite.config.ts server.port
GAME_DEV_URL = "http://127.0.0.1:5173/"

_PLACEHOLDER_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#1e1e1e;color:#9a9a9a;font-family:system-ui,sans-serif;font-size:15px;}
</style></head><body><p>__MSG__</p></body></html>"""


def _safe_placeholder(message: str) -> str:
    return _PLACEHOLDER_HTML.replace("__MSG__", html.escape(message))


try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebEngineCore import QWebEngineProfile

    from ..web_engine_page import QuietWebEnginePage
except ImportError:  # pragma: no cover
    QWebEngineView = None  # type: ignore[assignment,misc]
    QWebEngineProfile = None  # type: ignore[assignment,misc]
    QuietWebEnginePage = None  # type: ignore[assignment,misc]


_GAME_WEB_PROFILE = None


def _default_app_data_dir() -> Path:
    """Platform-appropriate fallback when Qt cannot resolve AppLocalDataLocation."""
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "GameDraft"
    xdg = os.environ.get("XDG_DATA_HOME", "")
    base = Path(xdg) if xdg else home / ".local" / "share"
    return base / "GameDraft"


def _game_webengine_profile():
    """Persistent profile for game preview; default Qt profile is off-the-record here."""
    global _GAME_WEB_PROFILE
    if QWebEngineProfile is None:
        return None
    if _GAME_WEB_PROFILE is not None:
        return _GAME_WEB_PROFILE

    profile = QWebEngineProfile("GameDraftGamePreview")
    base = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppLocalDataLocation)
    if not base:
        base = str(_default_app_data_dir())
    root = Path(base) / "webengine_game_preview"
    cache = root / "cache"
    storage = root / "storage"
    cache.mkdir(parents=True, exist_ok=True)
    storage.mkdir(parents=True, exist_ok=True)

    profile.setCachePath(str(cache))
    profile.setPersistentStoragePath(str(storage))
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.DiskHttpCache)
    profile.setPersistentCookiesPolicy(
        QWebEngineProfile.PersistentCookiesPolicy.AllowPersistentCookies,
    )
    _GAME_WEB_PROFILE = profile
    return profile


def _make_game_page(parent):
    if QuietWebEnginePage is None:
        return None
    profile = _game_webengine_profile()
    if profile is not None:
        return QuietWebEnginePage(profile, parent)
    return QuietWebEnginePage(parent)


class GameBrowserTab(QWidget):
    """Toolbar + embedded Chromium view (or fallback if WebEngine missing)."""

    run_requested = Signal()
    run_dev_requested = Signal()
    stop_requested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._has_webengine = QWebEngineView is not None

        root = QVBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)

        bar = QHBoxLayout()
        st = self.style()
        icon_sz = QSize(22, 22)

        self._btn_run = QPushButton(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaPlay), "",
        )
        self._btn_run.setToolTip("运行游戏 (F5)")
        self._btn_run.setIconSize(icon_sz)
        self._btn_run.clicked.connect(self.run_requested.emit)
        bar.addWidget(self._btn_run)

        self._btn_run_dev = QPushButton(
            st.standardIcon(QStyle.StandardPixmap.SP_ArrowForward), "",
        )
        self._btn_run_dev.setToolTip("运行游戏 — 开发模式 (Ctrl+F5)")
        self._btn_run_dev.setIconSize(icon_sz)
        self._btn_run_dev.clicked.connect(self.run_dev_requested.emit)
        bar.addWidget(self._btn_run_dev)

        self._btn_stop = QPushButton(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaStop), "",
        )
        self._btn_stop.setToolTip("停止游戏 (Shift+F5)")
        self._btn_stop.setIconSize(icon_sz)
        self._btn_stop.clicked.connect(self.stop_requested.emit)
        bar.addWidget(self._btn_stop)

        bar.addSpacing(16)

        self._btn_reload = QPushButton("Reload")
        self._btn_reload.clicked.connect(self._reload)
        self._btn_reload.setEnabled(self._has_webengine)
        bar.addWidget(self._btn_reload)

        self._btn_external = QPushButton("External browser")
        self._btn_external.clicked.connect(self._open_external)
        bar.addWidget(self._btn_external)

        bar.addWidget(QLabel("URL:"))
        self._url_line = QLineEdit(GAME_DEV_URL)
        self._url_line.setReadOnly(True)
        bar.addWidget(self._url_line, stretch=1)
        root.addLayout(bar)

        if self._has_webengine:
            self._view = QWebEngineView(self)
            if QuietWebEnginePage is not None:
                self._view.setPage(_make_game_page(self._view))
            self._view.setMinimumSize(0, 0)
            self._view.setSizePolicy(
                QSizePolicy.Policy.Ignored,
                QSizePolicy.Policy.Ignored,
            )
            root.addWidget(self._view, stretch=1)
            self.show_message(
                "Press Run (F5) to start the dev server and load the game here.",
            )
        else:
            self._view = None
            tip = QLabel(
                "PySide6 Qt WebEngine is not available. "
                "Install the full PySide6 extras or use Run with an external browser.",
            )
            tip.setWordWrap(True)
            tip.setAlignment(Qt.AlignmentFlag.AlignTop)
            root.addWidget(tip, stretch=1)

    # ---- public API for MainWindow ----------------------------------------

    def load_dev_url(self, url: str | None = None) -> None:
        if not self._view:
            return
        target = (url or GAME_DEV_URL).strip()
        if not target.endswith("/"):
            target += "/"
        self._url_line.setText(target)
        self._view.load(QUrl(target))

    def reload_dev_url(self) -> None:
        """Reload current page (same as toolbar Reload)."""
        self._reload()

    def show_message(self, message: str) -> None:
        if not self._view:
            return
        self._view.setHtml(_safe_placeholder(message))

    def is_webengine_available(self) -> bool:
        return self._has_webengine

    # ---- internals --------------------------------------------------------

    def _reload(self) -> None:
        if not self._view:
            return
        self._view.reload()

    def _open_external(self) -> None:
        QDesktopServices.openUrl(QUrl(self._url_line.text()))


class GamePlayWindow(QWidget):
    """Standalone popup window for game preview."""

    closed = Signal()

    def __init__(self, width: int = 1280, height: int = 720,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent, Qt.WindowType.Window)
        self.setWindowTitle("GameDraft")
        self.resize(width, height)
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self._native_close_armed = False

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        if QWebEngineView is not None:
            self._view = QWebEngineView(self)
            if QuietWebEnginePage is not None:
                self._view.setPage(_make_game_page(self._view))
            self._view.setMinimumSize(0, 0)
            self._view.setSizePolicy(
                QSizePolicy.Policy.Ignored,
                QSizePolicy.Policy.Ignored,
            )
            lay.addWidget(self._view)
        else:
            self._view = None

    def load_url(self, url: str) -> None:
        if self._view:
            self._view.load(QUrl(url))

    def reload(self) -> None:
        if self._view:
            self._view.reload()

    def is_available(self) -> bool:
        return self._view is not None

    def run_js(self, code: str) -> None:
        if self._view:
            self._view.page().runJavaScript(code)

    def run_js_result(self, code: str, timeout_ms: int = 1500) -> object | None:
        if not self._view:
            return None
        result: dict[str, object | None] = {"value": None}
        done = {"value": False}
        loop = QEventLoop()

        def finish(value: object | None = None) -> None:
            if done["value"]:
                return
            done["value"] = True
            result["value"] = value
            loop.quit()

        self._view.page().runJavaScript(code, finish)
        QTimer.singleShot(timeout_ms, finish)
        loop.exec()
        return result["value"]

    def closeEvent(self, event) -> None:
        # WebEngine 关窗口默认不触发 pagehide/beforeunload，必须先停 Howler 再关视图
        if self._native_close_armed:
            self.closed.emit()
            super().closeEvent(event)
            return

        if self._view is None:
            self._native_close_armed = True
            self.closeEvent(event)
            return

        event.ignore()
        done: list[bool] = [False]

        def arm_and_close(*_args: object) -> None:
            if done[0]:
                return
            done[0] = True
            self._native_close_armed = True
            self.close()

        js = """(function(){try{if(window.__gameDestroy)window.__gameDestroy();}catch(e){}
try{if(window.Howler){if(typeof Howler.stop==='function')Howler.stop();
if(typeof Howler.unload==='function')Howler.unload();}}catch(e){}})();0;"""
        self._view.page().runJavaScript(js, arm_and_close)
        QTimer.singleShot(400, arm_and_close)
