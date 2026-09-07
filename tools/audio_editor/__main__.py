# -*- coding: utf-8 -*-
"""音频编辑器桌面壳 —— PySide6 + QWebEngineView,全程禁用缓存。

为什么要壳而不是直接开浏览器:
  * 浏览器会缓存 HTML/JS 和音频。音频文件是被就地重渲染的(同名不同内容),
    一旦命中缓存就会听到旧版本,人会以为编辑没生效——这是最坑的一类假象。
  * 壳里用 off-the-record profile:内存 cookie、HTTP 缓存关到 NoCache、
    每次启动清一遍磁盘残留,并给每个请求打上 no-cache 头。

启动方式(两种都行):
  python -m tools.audio_editor            # 主编辑器 External tools 走这条
  python tools/audio_editor/__main__.py
"""
from __future__ import annotations

import shutil
import socket
import sys
import time
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
for p in (str(REPO), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from PySide6.QtCore import QUrl, Qt, QTimer  # noqa: E402
from PySide6.QtGui import QAction, QKeySequence  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QMainWindow, QMessageBox, QStatusBar,
)
from PySide6.QtWebEngineCore import (  # noqa: E402
    QWebEngineProfile, QWebEnginePage, QWebEngineSettings,
    QWebEngineUrlRequestInterceptor,
)
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402


def free_port(preferred: int) -> int:
    """优先用固定端口;被占用则退避到随机端口。

    探测 socket 必须开 SO_REUSEADDR,否则上一次运行残留的 TIME_WAIT
    会让固定端口看起来永远被占,每次启动都跳到随机端口。
    """
    for port in (preferred, 0):
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return s.getsockname()[1]
        except OSError:
            continue
        finally:
            s.close()
    return preferred


class NoCacheInterceptor(QWebEngineUrlRequestInterceptor):
    """每个请求都打 no-cache —— 音频是原地重渲染的,缓存会让人听到旧内容。"""

    def interceptRequest(self, info):
        info.setHttpHeader(b"Cache-Control", b"no-cache, no-store, must-revalidate")
        info.setHttpHeader(b"Pragma", b"no-cache")


class Window(QMainWindow):
    def __init__(self, url: str, port: int):
        super().__init__()
        self.setWindowTitle("寻狗记 · 音频编辑器")
        self.resize(1520, 940)

        # off-the-record:不落磁盘、不留 cookie
        self.profile = QWebEngineProfile(self)
        self.profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)
        self.profile.setPersistentCookiesPolicy(
            QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)
        self.profile.setHttpCacheMaximumSize(1)
        self.interceptor = NoCacheInterceptor()
        self.profile.setUrlRequestInterceptor(self.interceptor)
        try:
            self.profile.clearHttpCache()
            self.profile.cookieStore().deleteAllCookies()
        except Exception:
            pass

        self.view = QWebEngineView(self)
        self.page = QWebEnginePage(self.profile, self.view)
        self.view.setPage(self.page)
        s = self.page.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        s.setAttribute(QWebEngineSettings.WebAttribute.ScrollAnimatorEnabled, True)
        self.setCentralWidget(self.view)

        bar = QStatusBar()
        self.setStatusBar(bar)
        bar.showMessage(f"服务 127.0.0.1:{port} · 缓存已禁用")

        m = self.menuBar().addMenu("视图")
        self._act(m, "重新载入(丢弃缓存)", self.hard_reload, "Ctrl+R")
        self._act(m, "放大", lambda: self.view.setZoomFactor(self.view.zoomFactor() + .1), "Ctrl+=")
        self._act(m, "缩小", lambda: self.view.setZoomFactor(self.view.zoomFactor() - .1), "Ctrl+-")
        self._act(m, "实际大小", lambda: self.view.setZoomFactor(1.0), "Ctrl+0")
        m.addSeparator()
        self._act(m, "开发者工具", self.dev_tools, "F12")

        self.url = url
        self._loaded = False
        self._load_tries = 0
        self.view.loadFinished.connect(self._on_load_finished)
        # 首屏必须带看门狗:2026-09-08 实测这台机器上开窗那一次的请求会被掐掉
        # (服务端 GET / 写到一半抛 WinError 10053 "本机软件中止了已建立的连接"),
        # 表现是**整窗白屏**。关键在于这种掐法**连 loadFinished 都不发** ——
        # 加载卡死在 loadProgress 0 —— 所以"监听失败信号再重试"救不了,只能靠超时。
        # 隔 0.8s 重发一次就能成(实测第一次重发即 ok=True)。
        self._watchdog = QTimer(self)
        self._watchdog.timeout.connect(self._retry_load)
        self._watchdog.start(800)
        self.view.load(QUrl(url))

    #: 重发上限。到顶还没成说明不是这条时序问题,别无限刷请求,把话说清楚交给人。
    MAX_LOAD_TRIES = 15

    def _on_load_finished(self, ok: bool) -> None:
        if not ok:
            return                      # 失败不在这儿处理,交给看门狗统一重发
        self._loaded = True
        self._watchdog.stop()
        if self._load_tries:
            self.statusBar().showMessage(f"首屏被掐掉了,重发 {self._load_tries} 次后载入成功", 6000)

    def _retry_load(self) -> None:
        if self._loaded:
            self._watchdog.stop()
            return
        self._load_tries += 1
        if self._load_tries > self.MAX_LOAD_TRIES:
            self._watchdog.stop()
            self.statusBar().showMessage(
                f"页面一直载不进来(已重试 {self.MAX_LOAD_TRIES} 次)。"
                "服务本身是好的,按 Ctrl+R 再试,或看终端里的报错。")
            return
        self.statusBar().showMessage(f"首屏没载进来,重发第 {self._load_tries} 次…")
        self.view.stop()
        self.view.load(QUrl(self.url))

    def _act(self, menu, text, slot, shortcut=None):
        a = QAction(text, self)
        if shortcut:
            a.setShortcut(QKeySequence(shortcut))
        a.triggered.connect(slot)
        menu.addAction(a)
        self.addAction(a)
        return a

    def hard_reload(self):
        self.profile.clearHttpCache()
        # 手动重载同样可能被掐,所以把看门狗重新武装起来
        self._loaded = False
        self._load_tries = 0
        self._watchdog.start(800)
        self.page.triggerAction(QWebEnginePage.WebAction.ReloadAndBypassCache)
        self.statusBar().showMessage("已丢弃缓存并重新载入", 3000)

    def closeEvent(self, ev):
        """page 必须先于 profile 析构,否则 Qt 报
        "Release of profile requested but WebEnginePage still not deleted" 并可能崩。"""
        try:
            # 看门狗先停:关窗后它再开一枪就是往已析构的 page 上发请求
            self._watchdog.stop()
            if getattr(self, "_dev", None) is not None:
                self.page.setDevToolsPage(None)
                self._dev.close()
                self._dev.deleteLater()
                self._dev = None
            self.view.setPage(None)
            self.page.deleteLater()
            self.page = None
        except Exception:
            pass
        super().closeEvent(ev)

    def dev_tools(self):
        if getattr(self, "_dev", None) is None:
            self._dev = QWebEngineView()
            self._dev.setWindowTitle("开发者工具")
            self._dev.resize(1100, 700)
            self.page.setDevToolsPage(self._dev.page())
        self._dev.show()
        self._dev.raise_()


def main() -> int:
    import server as backend

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        app = QApplication(sys.argv)
        QMessageBox.critical(None, "音频编辑器",
                             "找不到 ffmpeg / ffprobe。\n渲染和导出都依赖它们,请先安装。")
        return 1

    port = free_port(backend.PORT)
    backend.PORT = port
    for d in (backend.IMPORTED, backend.CACHE):
        d.mkdir(parents=True, exist_ok=True)

    from http.server import ThreadingHTTPServer
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(("127.0.0.1", port), backend.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 等服务真正能接连接再开窗。Thread.start() 立刻返回,serve_forever()
    # 未必已进 accept 循环——抢先加载页面会让首屏 fetch 直接 Failed to fetch。
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)
    print(f"音频编辑器 · 内嵌服务 http://127.0.0.1:{port}/ · 缓存已禁用", flush=True)

    # Chromium 侧也把磁盘缓存关死
    sys.argv += ["--disable-http-cache", "--disk-cache-size=1",
                 "--incognito", "--disable-application-cache"]
    app = QApplication(sys.argv)
    app.setApplicationName("GameDraft 音频编辑器")

    win = Window(f"http://127.0.0.1:{port}/", port)
    win.show()
    # 三参版:必须带 context 对象,否则宿主销毁后回调仍会触发并碰已析构的 C++ 对象
    QTimer.singleShot(0, win, lambda: win.view.setFocus(Qt.FocusReason.OtherFocusReason))
    code = app.exec()
    srv.shutdown()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
