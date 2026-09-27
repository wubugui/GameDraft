"""Embedded game view for running the Vite dev game inside the editor (WebGPU → `tools.qt_webgpu.WebGpuView`)."""
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

from tools.qt_webgpu import WebGpuView, webgpu_view_available

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


_LEGACY_PURGED = False


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


def _make_game_view(parent):
    """游戏预览的网页视图。

    游戏渲染只有 WebGPU,而 QtWebEngine 没编 Dawn、永远拿不到 WebGPU 适配器(见 `tools/qt_webgpu.py`),
    所以这里用 `WebGpuView`(Windows 上是 WebView2)。缓存口径由它负责:每进程一个新的 WebView2
    用户数据目录 + 禁缓存开关——制作人 2026-09-08 定死"任何 desktop 窗口都不许留缓存"
    (缘由见 `tools/webengine_cache_policy.py`)。离屏平台 / 没装 QtWebView 时返回 None。
    """
    global _LEGACY_PURGED
    if not webgpu_view_available():
        return None
    if not _LEGACY_PURGED:
        _LEGACY_PURGED = True
        _purge_legacy_profile_dir()
    return WebGpuView(parent)


def _unavailable_reason() -> str:
    return (
        "这个环境建不了能跑 WebGPU 的网页视图(需要真窗口平台 + PySide6.QtWebView;"
        "QtWebEngine 没有 WebGPU,跑不了游戏)。用 External browser 在 Chrome / Edge 里开。"
    )


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
        self._view.run_js(_BOOT_PROBE_JS, self._on_probe)

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
        """重载一次。

        以前这里先清 HTTP 缓存、等 `clearHttpCacheCompleted` 再绕缓存重载(清理在飞时重载会把加载吊死)。
        预览换成 WebView2(`tools/qt_webgpu.WebGpuView`)之后没有可清的缓存:每个进程一份新的用户数据目录 +
        `--disable-http-cache`,坏字节无处可存——剩下能让模块图断掉的只有改坏的 import / dev server 半路挂掉,
        重载一次就是全部补救。
        """
        self._recovered = True
        self._ticks = 0
        self._log(
            "首屏没起来(main.ts 未执行、页面停在空壳上)——重载一次试试。",
        )
        if self._view is not None:
            self._view.reload()


class GameBrowserTab(QWidget):
    """Toolbar + embedded game view (`WebGpuView`; fallback label if it can't be built here)."""

    run_requested = Signal()
    run_dev_requested = Signal()
    stop_requested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._view = _make_game_view(self)
        self._has_webengine = self._view is not None
        self._placeholder_message: str | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)

        bar = QHBoxLayout()
        st = self.style()
        icon_sz = QSize(22, 22)

        self._btn_run = QPushButton(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaPlay), "",
        )
        self._btn_run.setToolTip("运行游戏 (F5) — 从标题界面开始")
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

        if self._view is not None:
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
            self._boot_watchdog = None
            tip = QLabel(_unavailable_reason())
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
        self._view.set_html(_safe_placeholder(message))

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
        self._view.run_js(code, callback)
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

        self._view = _make_game_view(self)
        if self._view is not None:
            self._view.setMinimumSize(0, 0)
            self._view.setSizePolicy(
                QSizePolicy.Policy.Ignored,
                QSizePolicy.Policy.Ignored,
            )
            lay.addWidget(self._view)
            self._boot_watchdog = _GameBootWatchdog(self._view, "window", self)
        else:
            self._boot_watchdog = None

    def load_url(self, url: str) -> None:
        if self._view:
            if self._boot_watchdog is not None:
                self._boot_watchdog.arm()
            self._view.load(QUrl(url))

    def showEvent(self, event) -> None:  # noqa: N802 — Qt 覆写
        super().showEvent(event)
        # 游戏页是原生子窗口(WebView2):窗口出来就把键盘焦点交给它,不然要先点一下画面才能操作
        if self._view is not None:
            QTimer.singleShot(0, self._view, self._view.focus_page)

    def reload(self) -> None:
        if self._view:
            if self._boot_watchdog is not None:
                self._boot_watchdog.arm()
            self._view.reload()

    def is_available(self) -> bool:
        return self._view is not None

    def run_js(self, code: str) -> None:
        if self._view:
            self._view.run_js(code)

    def run_js_async(self, code: str, callback) -> bool:
        """非阻塞取值：结果经 callback 回传。返回是否真的发出去了。

        轮询类用途（如缩略条播放头）必须走这条，不能用 run_js_result——
        后者内嵌 QEventLoop 阻塞，按 250ms 节奏跑会把编辑器 UI 拖住。
        """
        if not self._view:
            return False
        self._view.run_js(code, callback)
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

        self._view.run_js(code, finish)
        # WebView2 在导航途中会**同步**回调(报错串);那时 finish 已经跑过、loop.quit() 落空,
        # 再 exec 就永远等不到退出(超时回调见 done 已置位直接返回)——实测吊死过
        if not done["value"]:
            QTimer.singleShot(timeout_ms, loop, finish)
            loop.exec()
        return result["value"]

    def closeEvent(self, event) -> None:
        # 关窗流程里视图随时会被销毁,看门狗的下一拍不能再去碰视图。
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
        self._view.run_js(js, arm_and_close)
        QTimer.singleShot(400, self, arm_and_close)
