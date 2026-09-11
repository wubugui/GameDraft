"""Isolated native host for the web UI. No changes to desktop_shell or Tauri."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlencode

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]


def configure_engine():
    from tools.webengine_cache_policy import disable_all_caches
    disable_all_caches()
    flags = os.environ.get('QTWEBENGINE_CHROMIUM_FLAGS', '').split()
    disabled_features = {'IntensiveWakeUpThrottling', 'CalculateNativeWinOcclusion'}
    for flag in flags:
        if flag.startswith('--disable-features='):
            disabled_features.update(flag.split('=', 1)[1].split(','))
    flags = [flag for flag in flags if not flag.startswith('--disable-features=')]
    flags.append('--disable-features=' + ','.join(sorted(disabled_features)))
    for flag in ('--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
                 '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'):
        if flag not in flags:
            flags.append(flag)
    os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = ' '.join(flags)


def ensure_build():
    entry = TOOL / 'dist/index.html'
    sources = [*(TOOL / name for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts')), *TOOL.glob('web/*')]
    if entry.is_file() and all(p.stat().st_mtime <= entry.stat().st_mtime for p in sources if p.is_file()):
        return
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    if not (TOOL / 'node_modules/vite').is_dir():
        subprocess.run([npm, 'ci', '--no-audit', '--no-fund'], cwd=TOOL, check=True)
    subprocess.run([npm, 'run', 'build'], cwd=TOOL, check=True)


def main():
    parser = argparse.ArgumentParser(description='GameDraft 场景工作台（独立入口）')
    parser.add_argument('--serve', action='store_true', help='只启动 HTTP 服务，用于开发与验证')
    parser.add_argument('--port', type=int, default=0, help='默认自动分配，不占用旧工具端口')
    parser.add_argument('--scene', default='')
    parser.add_argument('--game-url', default='', help='可选：已运行的游戏开发服务地址')
    parser.add_argument('--selftest', type=Path)
    parser.add_argument('--screenshot', type=Path)
    args = parser.parse_args()
    configure_engine()
    ensure_build()
    from PySide6.QtCore import Qt, QUrl, QTimer, QEvent, QObject
    from PySide6.QtWidgets import QApplication, QMainWindow
    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication.instance() or QApplication(sys.argv[:1])
    from .backend import Backend, start_server
    backend = Backend(game_url=args.game_url)
    server = start_server(backend, args.port)
    url = f'http://127.0.0.1:{server.server_port}/?' + urlencode({'scene': args.scene})
    print(f'[scene-workbench] {url}', flush=True)
    if args.serve:
        timer = QTimer(app)
        timer.start(1000)
        timer.timeout.connect(lambda: None)
        try:
            return app.exec()
        finally:
            server.shutdown()
            server.server_close()
            backend.close()

    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from tools.webengine_cache_policy import apply_no_cache

    class Page(QWebEnginePage):
        console_counts = None

        def javaScriptConsoleMessage(self, level, message, line, source):
            if self.console_counts is None:
                self.console_counts = {}
            key = (source, line, message)
            count = self.console_counts.get(key, 0) + 1
            self.console_counts[key] = count
            if count <= 2:
                print(f'[web] {level.name} {source}:{line} {message}', flush=True)

        def acceptNavigationRequest(self, target, nav_type, main_frame):
            if main_frame:
                return target.host() == '127.0.0.1' and target.port() == server.server_port
            return target.host() in ('127.0.0.1', 'localhost')

    class Window(QMainWindow):
        approved = False
        closing = False

        def closeEvent(self, event):
            if self.approved:
                event.accept()
                return
            event.ignore()
            if not self.closing:
                self.closing = True
                page.runJavaScript('window.workbench ? window.workbench.requestClose() : (window.__closeResult="close")')

    win = Window()
    if args.selftest:
        # A native interaction/render test needs an exposed GPU surface; normal
        # app windows do not stay on top. This flag lasts only for the QA run.
        win.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
    win.setWindowTitle('GameDraft · 场景工作台')
    view = QWebEngineView(win)
    profile = QWebEngineProfile(view)  # Off-the-record: never shares any old window's profile.
    apply_no_cache(profile)
    profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)
    page = Page(profile, view)
    settings = page.settings()
    settings.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
    page.featurePermissionRequested.connect(lambda origin, feature: page.setFeaturePermission(
        origin, feature, QWebEnginePage.PermissionPolicy.PermissionDeniedByUser))
    page.fullScreenRequested.connect(lambda request: request.accept())
    profile.downloadRequested.connect(lambda item: item.cancel())
    view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
    view.setPage(page)
    win.setCentralWidget(view)
    win.resize(1600, 1000)

    class DesktopKeys(QObject):
        def eventFilter(self, watched, event):
            if event.type() == QEvent.Type.KeyPress:
                control = event.modifiers() & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier)
                alt = event.modifiers() & Qt.KeyboardModifier.AltModifier
                if control and event.key() == Qt.Key.Key_S:
                    page.runJavaScript('document.activeElement?.blur(); window.workbench?.workspace.run(() => window.workbench.workspace.saveAll())')
                    return True
                if event.key() == Qt.Key.Key_F5 or (control and event.key() in (Qt.Key.Key_R, Qt.Key.Key_P)) or (alt and event.key() in (Qt.Key.Key_Left, Qt.Key.Key_Right)):
                    return True
            return False
    key_filter = DesktopKeys(win)
    app.installEventFilter(key_filter)

    def poll_close():
        if not win.closing:
            return
        def got(value):
            if value == 'close':
                win.approved = True
                win.close()
            elif value == 'cancel':
                win.closing = False
                page.runJavaScript('window.__closeResult=""')
        page.runJavaScript('window.__closeResult || ""', got)
    close_timer = QTimer(win)
    close_timer.timeout.connect(poll_close)
    close_timer.start(150)

    if args.selftest:
        assert profile.isOffTheRecord()
        assert profile.httpCacheType() == QWebEngineProfile.HttpCacheType.NoCache
        assert not settings.testAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture)
        assert not settings.testAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled)
        print('PASS native off-the-record / NoCache / autoplay / no LocalStorage', flush=True)
        from PySide6.QtCore import QPoint
        from PySide6.QtTest import QTest
        def native_action(value):
            if not value:
                return
            action = json.loads(value)
            target = view.focusProxy() or view
            point = QPoint(round(action.get('x', 0)), round(action.get('y', 0)))
            if action['type'] == 'click':
                QTest.mouseClick(target, Qt.MouseButton.LeftButton, pos=point)
            elif action['type'] == 'input':
                QTest.mouseClick(target, Qt.MouseButton.LeftButton, pos=point)
                QTest.keyClick(target, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier)
                QTest.keyClicks(target, action['text'])
                QTest.keyClick(target, getattr(Qt.Key, 'Key_' + action.get('finishKey', 'Tab')))
            elif action['type'] == 'key':
                QTest.keyClick(target, getattr(Qt.Key, 'Key_' + action['key']))
            elif action['type'] == 'drag':
                button = Qt.MouseButton.RightButton if action.get('button') == 'right' else Qt.MouseButton.LeftButton
                QTest.mousePress(target, button, pos=point)
                for i in range(1, 7):
                    QTest.mouseMove(target, QPoint(round(point.x() + action['dx'] * i / 6), round(point.y() + action['dy'] * i / 6)))
                    QTest.qWait(20)
                QTest.mouseRelease(target, button, pos=QPoint(round(point.x() + action['dx']), round(point.y() + action['dy'])))
            QTimer.singleShot(100, win, lambda: page.runJavaScript('window.__nativeAck = (window.__nativeAck || 0) + 1'))
        native_timer = QTimer(win)
        native_timer.timeout.connect(lambda: page.runJavaScript('JSON.stringify(window.__nativeActions?.shift() || null)', lambda value: native_action(value) if value and value != 'null' else None))
        native_timer.start(150)
        done = [False]
        def finish(value):
            if done[0] or not value:
                return
            done[0] = True
            print(value, flush=True)
            capture_attempt = [0]
            def expose_for_capture():
                # Re-expose the native surface even if the desktop obscured the
                # window while keyboard events went into the embedded game.
                win.hide()
                win.showNormal()
                win.raise_()
                win.activateWindow()
                page.setVisible(True)
                view.update()
                QTimer.singleShot(1500, win, capture_and_exit)
            def capture_and_exit():
                failed = 'FAIL' in value or 'EXC' in value
                if args.screenshot:
                    shot = view.grab()
                    raster = shot.toImage()
                    colors = {raster.pixelColor(int(raster.width() * x / 12), int(raster.height() * y / 12)).rgba()
                              for x in range(1, 12) for y in range(1, 12)}
                    if len(colors) < 5 and capture_attempt[0] < 2:
                        capture_attempt[0] += 1
                        expose_for_capture()
                        return
                    if len(colors) < 5:
                        print('FAIL screenshot: native surface stayed blank', flush=True)
                        failed = True
                    args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                    shot.save(str(args.screenshot))
                win.approved = True
                app.exit(1 if failed else 0)
            if args.screenshot:
                # QWidget.grab of an occluded accelerated WebEngine can be blank.
                # Expose only this QA window briefly, never change other windows.
                win.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
                expose_for_capture()
            else:
                capture_and_exit()
        test_timer = QTimer(win)
        test_timer.timeout.connect(lambda: page.runJavaScript('window.__selftestResult || ""', finish))
        test_timer.start(500)
        page.loadFinished.connect(lambda ok: page.runJavaScript(args.selftest.read_text(encoding='utf-8')) if ok else finish('FAIL page load'))
        QTimer.singleShot(180000, win, lambda: finish('FAIL selftest timeout'))
    page.setAudioMuted(False)
    view.load(QUrl(url))
    win.show()
    try:
        return app.exec()
    finally:
        server.shutdown()
        server.server_close()
        backend.close()
