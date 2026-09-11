"""Embedded WebEngine panel for running the Vite dev game inside the editor."""
from __future__ import annotations

import html
import os
import shutil
import sys
from pathlib import Path

from PySide6.QtCore import (
    Qt, QObject, Signal, QUrl, QSize, QTimer, QEventLoop, QStandardPaths,
)
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel,
    QLineEdit, QStyle, QSizePolicy,
)

from tools.webengine_cache_policy import apply_no_cache

from .. import theme

# Default must match vite.config.ts server.port
GAME_DEV_URL = "http://127.0.0.1:5173/"

_PLACEHOLDER_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:__BG__;color:__FG__;font-family:system-ui,sans-serif;font-size:__FONT_PX__;}
</style></head><body><p>__MSG__</p></body></html>"""


def _placeholder_colors() -> tuple[str, str]:
    """占位页背景/前景跟随当前主题(审查 P3:此前硬编码深色,浅色主题不可读)。"""
    try:
        if theme.is_dark_theme(theme.current_theme_id()):
            return "#1e1e1e", "#9a9a9a"
    except Exception:
        return "#1e1e1e", "#9a9a9a"
    return "#ececec", "#555555"


def _safe_placeholder(message: str) -> str:
    bg, fg = _placeholder_colors()
    return (
        _PLACEHOLDER_HTML
        .replace("__MSG__", html.escape(message))
        .replace("__FONT_PX__", theme.css_font_px(theme.FONT_ROLE_PROMINENT))
        .replace("__BG__", bg)
        .replace("__FG__", fg)
    )


try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile

    from ..web_engine_page import QuietWebEnginePage
except ImportError:  # pragma: no cover
    QWebEngineView = None  # type: ignore[assignment,misc]
    QWebEnginePage = None  # type: ignore[assignment,misc]
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


def _legacy_profile_dir() -> Path:
    """2026-09-08 之前那份落盘 profile 的位置(现已废弃,只用来删)。"""
    base = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppLocalDataLocation)
    if not base:
        base = str(_default_app_data_dir())
    return Path(base) / "webengine_game_preview"


def _purge_legacy_profile_dir() -> None:
    """把旧版留在磁盘上的缓存/存储整个删掉——它正是那次黑屏的载体,留着只会误导下一个人。

    尽力而为:删不掉(权限/被别的实例占着)也绝不能拦住编辑器启动。
    """
    root = _legacy_profile_dir()
    if not root.exists():
        return
    try:
        shutil.rmtree(root)
        print(f"[game-preview] 已删除废弃的落盘 profile:{root}", file=sys.stderr, flush=True)
    except OSError as e:  # pragma: no cover - 占用/权限,和预览本身无关
        print(f"[game-preview] 废弃 profile 删不掉({e}),不影响运行:{root}",
              file=sys.stderr, flush=True)


def _game_webengine_profile():
    """游戏预览的 profile:**off-the-record + NoCache,一个字节都不落盘。**

    制作人 2026-09-08 定死"任何 desktop 窗口都不许留缓存"(缘由与全仓口径见
    `tools/webengine_cache_policy.py`)。这里连 `setPersistentStoragePath` 一起去掉,
    走无名构造 = off-the-record:HTTP 缓存、V8 code cache、GPUCache、localStorage 统统不落地。
    预览不丢任何东西——存档与设置早就走 dev server 的文件后端
    (`src/core/storage/persistentStore.ts` 优先选 HttpFileStore),localStorage 只是它的兜底。
    """
    global _GAME_WEB_PROFILE
    if QWebEngineProfile is None:
        return None
    if _GAME_WEB_PROFILE is not None:
        return _GAME_WEB_PROFILE

    _purge_legacy_profile_dir()
    profile = QWebEngineProfile()          # 无名 = off-the-record,不落磁盘
    apply_no_cache(profile)
    _GAME_WEB_PROFILE = profile
    return profile


def _make_game_page(parent):
    if QuietWebEnginePage is None:
        return None
    profile = _game_webengine_profile()
    if profile is not None:
        return QuietWebEnginePage(profile, parent)
    return QuietWebEnginePage(parent)


#: 页面自证"`src/main.ts` 真的跑过"的探针。`__GAMEDRAFT_BUILD__` 是 main.ts 顶层
#: 无条件写的常量,模块图一断就绝不会出现;游戏自己的两块错误屏(启动失败 / 入口卫兵
#: 拦截)也算"活着",那是人能读的画面,别拿缓存去砸它。
_BOOT_PROBE_JS = """(function(){
  try {
    if (window.__GAMEDRAFT_BUILD__) return 'booted';
    if (document.getElementById('game-fatal-error')) return 'fatal';
    if (document.getElementById('game-entry-blocked')) return 'blocked';
    return 'blank:' + document.readyState;
  } catch (e) { return 'blank:throw'; }
})()"""


class _GameBootWatchdog(QObject):
    """首屏看门狗:载入后若干秒内页面必须自证 `main.ts` 跑过,否则重载一次并把话说清楚。

    起因是 2026-09-08 那次"整窗纯黑、点不动":当时预览用的持久磁盘缓存烂了,坏条目在
    revalidate 时被当响应体喂回渲染进程,`/src/ui/debugLightingSection.ts` 变成
    `Uncaught SyntaxError`,模块图断掉、`main.ts` 一行没跑,页面停在 index.html 的 `#111` 上。
    那条根因**已经被连根拔掉**(桌面窗口一律不留缓存,见 `tools/webengine_cache_policy.py`),
    这里留下来是因为那次暴露的**失效形状**本身还在:

    - `loadFinished` 照样 `True`(HTML 本身载入成功了),"加载失败"类的重试救不了;
    - 渲染进程 CPU 归零(没有 rAF),看起来像卡死,其实是根本没启动;
    - 页面停在宿主壳的 `#111` 上,和"游戏画了一帧黑"肉眼分不出来。

    任何让模块图断掉的东西(改坏的 import、dev server 半路挂掉)都长这个样。所以判据只有
    一条:**页面自己证明 `main.ts` 跑过了**;证明不了就重载一次,再不行就把话打进日志交给人,
    别无限刷请求。
    """

    #: 探针节奏。两拍(≈5s)还是白的就动手——首屏几百个模块在慢机上也就 2~3s。
    _TICK_MS = 2500
    _GRACE_TICKS = 2
    #: 补救之后再给的观察拍数;到顶就闭嘴,不再动缓存。
    _MAX_TICKS = 6

    def __init__(self, view, label: str, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._view = view
        self._label = label
        self._ticks = 0
        self._recovered = False
        self._done = True
        self._timer = QTimer(self)
        self._timer.setInterval(self._TICK_MS)
        self._timer.timeout.connect(self._tick)

    def arm(self) -> None:
        """每次真正去载游戏页时调用(占位页不要武装,它本来就没有 main.ts)。"""
        self._ticks = 0
        self._recovered = False
        self._done = False
        self._timer.start()

    def disarm(self) -> None:
        self._done = True
        self._timer.stop()

    # ---- internals --------------------------------------------------------

    def _log(self, message: str) -> None:
        # 编辑器的 stderr 被 dev_console 收着;这里是黑屏时唯一的线索,不能因为编码炸掉。
        try:
            sys.stderr.write(f"[game-preview:{self._label}] {message}\n")
            sys.stderr.flush()
        except Exception:  # pragma: no cover - 控制台编码/句柄异常不该拖垮预览
            pass

    def _tick(self) -> None:
        if self._done or self._view is None:
            self._timer.stop()
            return
        self._ticks += 1
        if self._ticks > self._MAX_TICKS:
            self.disarm()
            return
        page = self._view.page()
        if page is None:
            self.disarm()
            return
        page.runJavaScript(_BOOT_PROBE_JS, self._on_probe)

    def _on_probe(self, verdict: object) -> None:
        if self._done:
            return
        if isinstance(verdict, str) and not verdict.startswith("blank"):
            # booted / fatal / blocked:页面已经能自己说话了,收工。
            self.disarm()
            return
        if self._ticks < self._GRACE_TICKS:
            return
        if not self._recovered:
            self._recover()
            return
        if self._ticks >= self._MAX_TICKS:
            self._log(
                "重载后页面仍然没起来(main.ts 没执行)。往上翻这条日志里的 js 报错——"
                "模块图断了(改坏的 import / dev server 半路挂掉)最常见。",
            )
            self.disarm()

    def _recover(self) -> None:
        """清一遍缓存(现在本就是空的)再绕过缓存重载一次。

        profile 已经是 off-the-record + `NoCache`,这一手是**兜底**:万一哪天有人给某个壳
        重新接上缓存,这条路径仍然能自愈,不必再查一遍 2026-09-08 那场。

        ⚠ **两件事的先后不能颠倒**:`clearHttpCache()` 是异步的,清理**在飞的时候发起重载
        会把这次加载整个吊死**(2026-09-08 实测:`loadStarted` 之后 `loadFinished` 再也不来,
        页面永远停在旧文档上)。等 `clearHttpCacheCompleted` 再重载则实测能救回来。
        老 Qt 上没有这个信号,就退化成只绕缓存重载。
        """
        self._recovered = True
        self._ticks = 0
        self._log(
            "首屏没起来(main.ts 未执行、页面停在空壳上)——重载一次试试。",
        )
        profile = _game_webengine_profile()
        signal = getattr(profile, "clearHttpCacheCompleted", None) if profile else None
        if signal is None:
            self._reload_bypassing_cache()
            return

        def on_cleared() -> None:
            try:
                signal.disconnect(on_cleared)
            except (RuntimeError, TypeError):  # pragma: no cover - 已断开/已析构
                pass
            self._reload_bypassing_cache()

        signal.connect(on_cleared)
        profile.clearHttpCache()

    def _reload_bypassing_cache(self) -> None:
        if self._done or self._view is None:
            return
        page = self._view.page()
        if page is None or QWebEnginePage is None:
            return
        page.triggerAction(QWebEnginePage.WebAction.ReloadAndBypassCache)


class GameBrowserTab(QWidget):
    """Toolbar + embedded Chromium view (or fallback if WebEngine missing)."""

    run_requested = Signal()
    run_dev_requested = Signal()
    stop_requested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._has_webengine = QWebEngineView is not None
        self._placeholder_message: str | None = None

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
            self._boot_watchdog = _GameBootWatchdog(self._view, "tab", self)
            root.addWidget(self._view, stretch=1)
            self.show_message(
                "Press Run (F5) to start the dev server and load the game here.",
            )
        else:
            self._view = None
            self._boot_watchdog = None
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
        self._placeholder_message = None
        if self._boot_watchdog is not None:
            self._boot_watchdog.arm()
        self._view.load(QUrl(target))

    def reload_dev_url(self) -> None:
        """Reload current page (same as toolbar Reload)."""
        self._reload()

    def show_message(self, message: str) -> None:
        if not self._view:
            return
        # 占位页没有 main.ts,看门狗必须先撤,否则它会拿占位页当"没起来"去清缓存。
        if self._boot_watchdog is not None:
            self._boot_watchdog.disarm()
        self._placeholder_message = message
        self._view.setHtml(_safe_placeholder(message))

    def on_editor_theme_changed(self, _theme_id: str) -> None:
        if self._placeholder_message is not None:
            self.show_message(self._placeholder_message)

    def is_webengine_available(self) -> bool:
        return self._has_webengine

    def run_js_async(self, code: str, callback) -> bool:
        """非阻塞取值：结果经 callback 回传。返回是否真的发出去了。

        与 GamePlayWindow.run_js_async 同签名——游戏可能跑在内嵌页签也可能在弹出窗口，
        调用方（主窗轮询）按同一个鸭子接口对待两者。
        """
        if not self._view:
            return False
        self._view.page().runJavaScript(code, callback)
        return True

    # ---- internals --------------------------------------------------------

    def _reload(self) -> None:
        if not self._view:
            return
        # 占位页上按 Reload 不该武装看门狗(重载出来的还是占位页)。
        if self._boot_watchdog is not None and self._placeholder_message is None:
            self._boot_watchdog.arm()
        self._view.reload()

    def _open_external(self) -> None:
        QDesktopServices.openUrl(QUrl(self._url_line.text()))


class GamePlayWindow(QWidget):
    """Standalone popup window for game preview."""

    closed = Signal()

    def __init__(self, width: int = 1024, height: int = 768,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent, Qt.WindowType.Window)
        self.setWindowTitle("GameDraft")
        # 缺省与游戏标准视口同比例（4:3）；正常调用方传的是 game_config.windowSize
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
            self._boot_watchdog = _GameBootWatchdog(self._view, "window", self)
        else:
            self._view = None
            self._boot_watchdog = None

    def load_url(self, url: str) -> None:
        if self._view:
            if self._boot_watchdog is not None:
                self._boot_watchdog.arm()
            self._view.load(QUrl(url))

    def reload(self) -> None:
        if self._view:
            if self._boot_watchdog is not None:
                self._boot_watchdog.arm()
            self._view.reload()

    def is_available(self) -> bool:
        return self._view is not None

    def run_js(self, code: str) -> None:
        if self._view:
            self._view.page().runJavaScript(code)

    def run_js_async(self, code: str, callback) -> bool:
        """非阻塞取值：结果经 callback 回传。返回是否真的发出去了。

        轮询类用途（如缩略条播放头）必须走这条，不能用 run_js_result——
        后者内嵌 QEventLoop 阻塞，按 250ms 节奏跑会把编辑器 UI 拖住。
        """
        if not self._view:
            return False
        self._view.page().runJavaScript(code, callback)
        return True

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
        QTimer.singleShot(timeout_ms, loop, finish)
        loop.exec()
        return result["value"]

    def closeEvent(self, event) -> None:
        # 关窗流程里视图随时会被销毁,看门狗的下一拍不能再去碰 page()。
        if self._boot_watchdog is not None:
            self._boot_watchdog.disarm()
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
        QTimer.singleShot(400, self, arm_and_close)
