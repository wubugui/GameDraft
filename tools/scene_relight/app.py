"""场景重打光工作台——桌面壳(PySide6 + QWebEngineView)。

- 同进程后台线程跑 serve.py 的 HTTP 服务(127.0.0.1,缺省临时端口,不与
  浏览器模式的 5317 打架);
- **浏览器缓存全灭,三层**:
  ① WebEngine 用 off-the-record profile(构造时不给 storageName)——
     整个 profile 落在内存,磁盘上根本没有缓存目录;
  ② 再显式 NoCache + NoPersistentCookies(防未来有人给 profile 起名);
  ③ 服务端本就对一切响应发 `Cache-Control: no-store`(serve.py)。
  背景:内嵌页吃旧缓存的坑在 character_lighting_lab 真踩过
  ("改完代码刷新看不到变化,阶段清单全程停在未开始")。
- F5 / Ctrl+R / Ctrl+Shift+R 刷新;窗口关了进程就退(服务线程是 daemon)。
- `--smoke` 供无头自检:offscreen 下起真 WebEngine,load 完成即退。
"""
from __future__ import annotations

import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def start_server(port: int = 0) -> int:
    """后台线程起工作台服务,返回实际端口(port=0 由系统分配)。"""
    from tools.scene_relight.serve import H
    httpd = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return int(httpd.server_address[1])


def main(port: int | None = None, smoke: bool = False) -> int:
    from PySide6.QtCore import Qt, QTimer, QUrl
    from PySide6.QtGui import QKeySequence, QShortcut
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWidgets import QApplication, QMainWindow

    # WebEngine 硬要求:必须在 QApplication 构造前设,否则直接 crash/黑屏
    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts, True)
    app = QApplication(sys.argv)
    actual_port = start_server(port or 0)

    win = QMainWindow()
    win.setWindowTitle('场景重打光工作台')
    view = QWebEngineView(win)
    # ① off-the-record:不给 storageName → 纯内存 profile,零磁盘缓存
    profile = QWebEngineProfile(view)
    # ② 显式双保险
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)
    profile.setPersistentCookiesPolicy(
        QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)
    page = QWebEnginePage(profile, view)
    view.setPage(page)
    win.setCentralWidget(view)
    win.resize(1560, 980)
    for seq in ('F5', 'Ctrl+R', 'Ctrl+Shift+R'):
        QShortcut(QKeySequence(seq), win, activated=view.reload)

    if smoke:
        def _loaded(ok: bool) -> None:
            print(f'[smoke] loadFinished ok={ok} port={actual_port}', flush=True)
            QTimer.singleShot(300, lambda: app.exit(0 if ok else 2))
        view.loadFinished.connect(_loaded)
        QTimer.singleShot(20000, lambda: (print('[smoke] timeout', flush=True), app.exit(3)))

    view.load(QUrl(f'http://127.0.0.1:{actual_port}/'))
    win.show()
    return app.exec()


if __name__ == '__main__':
    sys.exit(main(smoke='--smoke' in sys.argv))
