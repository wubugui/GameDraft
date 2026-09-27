"""Isolated native host for the web UI (WebView2 via tools/qt_webgpu — the runtime tab embeds the WebGPU game)."""
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
    """网页视图的进程级开关:禁缓存 + WebGPU / 游戏宿主(免手势音频、没焦点 / 被挡住不降级)。
    都只在内核初始化时读一次,必须排在 QApplication 之前。"""
    from tools.qt_webgpu import apply_webgpu_chromium_flags
    from tools.webengine_cache_policy import disable_all_caches
    disable_all_caches()
    apply_webgpu_chromium_flags()


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

    # 网页视图用 WebGpuView(Windows 上是 WebView2):「运行时」页签的 iframe 里跑的是真游戏,渲染只有 WebGPU,
    # QtWebEngine 没编 Dawn、拿不到 WebGPU 适配器(见 tools/qt_webgpu.py)。跨源 iframe 里的 WebGPU 在 WebView2
    # 下不用 allow="webgpu" 也能拿到(2026-09-27 实测)。
    from tools.qt_webgpu import (
        WebGpuView, bring_to_foreground, native_key, native_mouse, native_type, release_webgpu_view,
    )

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
                view.run_js('window.workbench ? window.workbench.requestClose() : (window.__closeResult="close")')

    win = Window()
    if args.selftest:
        # A native interaction/render test needs an exposed GPU surface; normal
        # app windows do not stay on top. This flag lasts only for the QA run.
        win.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
    win.setWindowTitle('GameDraft · 场景工作台')
    view = WebGpuView(win, forward_console=False)
    console_counts: dict = {}

    def on_console(level, message, source, line):
        key = (source, line, message)
        count = console_counts.get(key, 0) + 1
        console_counts[key] = count
        if count <= 2:
            print(f'[web] {level} {source}:{line} {message}', flush=True)
    view.consoleMessage.connect(on_console)
    win.setCentralWidget(view)
    win.resize(1600, 1000)

    # QtWebEngine 时代由宿主做的几件事(只准导航到本工作台、禁右键菜单、禁新窗口 / 下载、F5 / Ctrl+R / Ctrl+P /
    # Alt+←→ 不许把页面刷掉、Ctrl+S 存全部),WebView2 没有对应接口、按键也不经过 Qt(原生子窗口吞掉),
    # 改在页面里做:每次载入完成注入一次。拖进来的文件、链接点击若没被界面自己处理,一律不导航。
    guard_js = """(function(){
  if (window.__workbenchHostGuard) return; window.__workbenchHostGuard = true;
  addEventListener('keydown', function(e){
    var ctl = e.ctrlKey || e.metaKey;
    if (ctl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation();
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur();
        window.workbench && window.workbench.workspace.run(function(){ return window.workbench.workspace.saveAll(); }); } catch (err) {}
      return; }
    if (e.key === 'F5' || (ctl && /^[rRpP]$/.test(e.key)) || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
      e.preventDefault(); e.stopPropagation(); }
  }, true);
  addEventListener('contextmenu', function(e){ e.preventDefault(); });
  addEventListener('dragover', function(e){ if (!e.defaultPrevented) e.preventDefault(); });
  addEventListener('drop', function(e){ if (!e.defaultPrevented) e.preventDefault(); });
  addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && !e.defaultPrevented && a.origin !== location.origin) e.preventDefault();
  });
  window.open = function(){ return null; };
})();"""
    view.loadFinished.connect(lambda ok: view.run_js(guard_js) if ok else None)
    home = f'http://127.0.0.1:{server.server_port}/'

    def keep_home(target):
        # 兜底:真被导航走了(界面没拦住的外链等)就回来,别把工作台留在别的页面上
        if target.scheme() in ('http', 'https') and not target.toString().startswith(home):
            print(f'[scene-workbench] 拦下主框架导航:{target.toString()}', flush=True)
            view.load(QUrl(url))
    view.urlChanged.connect(keep_home)

    class DesktopKeys(QObject):
        def eventFilter(self, watched, event):
            if event.type() == QEvent.Type.KeyPress:
                control = event.modifiers() & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier)
                alt = event.modifiers() & Qt.KeyboardModifier.AltModifier
                if control and event.key() == Qt.Key.Key_S:
                    view.run_js('document.activeElement?.blur(); window.workbench?.workspace.run(() => window.workbench.workspace.saveAll())')
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
                view.run_js('window.__closeResult=""')
        view.run_js('window.__closeResult || ""', got)
    close_timer = QTimer(win)
    close_timer.timeout.connect(poll_close)
    close_timer.start(150)

    if args.selftest:
        # 缓存口径:WebView2 每进程一份新的用户数据目录 + 禁缓存开关(见 tools/qt_webgpu.py)
        print('PASS native per-process WebView2 profile / no-cache flags / autoplay flag', flush=True)

        def native_action(value):
            if not value:
                return
            action = json.loads(value)
            x, y = action.get('x', 0), action.get('y', 0)
            # 原生输入走系统队列(SendInput,会真动鼠标):窗口已置顶。键盘发给当前焦点——前一步的点击已把焦点
            # 交给网页(含 iframe 里的游戏);窗口已经是活动窗口时别再 activateWindow / focus_page,
            # 那会把 Win32 焦点拉回宿主或网页顶层文档,iframe 就收不到键了
            if not bring_to_foreground(win):
                print('[scene-workbench] 自检窗口提不到系统前台,原生按键可能落空', flush=True)
            if action['type'] == 'click':
                native_mouse(view, x, y, 'click')
            elif action['type'] == 'input':
                native_mouse(view, x, y, 'click')
                QTest.qWait(150)       # 真点击经系统队列进浏览器进程,焦点落到输入框前别急着 Ctrl+A(否则全选整页)
                native_key('A', modifiers=('Ctrl',))
                native_type(action['text'])
                native_key(action.get('finishKey', 'Tab'))
            elif action['type'] == 'key':
                native_key(action['key'])
            elif action['type'] == 'drag':
                # 页面上残留的文字选区会让真鼠标按下直接起 HTML 拖放(dragstart → pointercancel,拖动全丢);
                # QTest 合成的事件不走系统拖放检测所以以前碰不到。拖之前先清掉
                view.run_js('window.getSelection && getSelection().removeAllRanges()')
                QTest.qWait(50)
                button = 'right' if action.get('button') == 'right' else 'left'
                native_mouse(view, x, y, 'press', button)
                for i in range(1, 7):
                    native_mouse(view, x + action['dx'] * i / 6, y + action['dy'] * i / 6, 'move', button)
                    QTest.qWait(20)
                native_mouse(view, x + action['dx'], y + action['dy'], 'release', button)
            QTimer.singleShot(100, win, lambda: view.run_js('window.__nativeAck = (window.__nativeAck || 0) + 1'))
        from PySide6.QtTest import QTest
        native_timer = QTimer(win)
        native_timer.timeout.connect(lambda: view.run_js('JSON.stringify(window.__nativeActions?.shift() || null)', lambda value: native_action(value) if value and value != 'null' else None))
        native_timer.start(150)
        done = [False]

        def finish(value):
            if done[0] or not value:
                return
            done[0] = True
            print(value, flush=True)
            failed = 'FAIL' in value or 'EXC' in value
            if args.screenshot:
                # 原生窗口 QWidget.grab() 截不到网页;grab_image 走 PrintWindow,被挡住也截得到
                shot = view.grab_image()
                colors = {shot.pixelColor(int(shot.width() * x / 12), int(shot.height() * y / 12)).rgba()
                          for x in range(1, 12) for y in range(1, 12)}
                if len(colors) < 5:
                    print('FAIL screenshot: native surface stayed blank', flush=True)
                    failed = True
                args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                shot.save(str(args.screenshot))
            win.approved = True
            app.exit(1 if failed else 0)
        test_timer = QTimer(win)
        test_timer.timeout.connect(lambda: view.run_js('window.__selftestResult || ""', finish))
        test_timer.start(500)
        view.loadFinished.connect(lambda ok: view.run_js(args.selftest.read_text(encoding='utf-8')) if ok else finish('FAIL page load'))
        QTimer.singleShot(180000, win, lambda: finish('FAIL selftest timeout'))
    view.load(QUrl(url))
    win.show()
    try:
        return app.exec()
    finally:
        release_webgpu_view(view)
        server.shutdown()
        server.server_close()
        backend.close()
