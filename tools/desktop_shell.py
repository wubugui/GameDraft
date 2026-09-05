"""本地网页工具的**桌面壳**:一个窗口、一个进程、临时端口、单实例。

原来只有 `tools/scene_relight/app.py` 有这么一份;2026-08-31 提成共用,
让角色照明实验室(现在是光照烘焙的唯一入口)也用上。

## 它保证的四条(每一条都对应一个真踩过的坑)

- **端口不用你管**:绑 `127.0.0.1:0`,端口由系统分配。永远不会"端口被占"。
- **不留残留**:HTTP 服务跑在 daemon 线程里,主进程一退就没了;
  子进程(烘焙、装依赖)由 `tools.child_jobs` 塞进 Job Object,
  **父进程无论怎么死,内核都会杀光整棵进程树**。
- **禁止双开**:闸是 Windows **命名 mutex**(`CreateMutexW` + `ERROR_ALREADY_EXISTS`,
  内核级原子,进程死了自动释放,没有陈旧状态)。抢不到就试着把已有实例叫到前台,然后退出。
  ⚠ 不能拿 QLocalServer.listen 当闸:Windows 命名管道天然多实例,listen **从不失败**
  (2026-08-31 跨进程实测),它在这里只当"叫前台"的消息通道用。双开的代价不是多占内存,
  是**两个进程并发写同一批烘焙产物且都合法** —— 静默且难查。
- **零浏览器缓存**:① off-the-record profile(不给 storageName ⇒ 纯内存,磁盘上根本
  没有缓存目录)② 显式 `NoCache` + `NoPersistentCookies` ③ 服务端一切响应 `no-store`。
  内嵌页吃旧缓存的坑在 `character_lighting_lab` 真踩过("改完代码刷新看不到变化")。

## 用法

    from tools.desktop_shell import run_desktop

    return run_desktop(handler_cls=H, title='角色照明实验室', app_id='char-lighting-lab')

`--smoke` 供无头自检:offscreen 下起真 WebEngine,load 完成即退。
"""
from __future__ import annotations

import sys
import threading
from http.server import ThreadingHTTPServer


def start_server(handler_cls, port: int = 0) -> int:
    """后台 daemon 线程起服务,返回实际端口(port=0 由系统分配)。"""
    httpd = ThreadingHTTPServer(('127.0.0.1', port), handler_cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return int(httpd.server_address[1])


def _acquire_single_instance_mutex(app_id: str):
    """抢单实例闸(Windows 命名 mutex)。

    返回值:
    - 句柄(truthy) —— 抢到了,调用方要**保住引用**到进程结束(内核在进程死亡时自动释放,
      无论怎么死:崩溃、taskkill、TaskStop 都不会留下陈旧状态);
    - None —— 已有实例持有(ERROR_ALREADY_EXISTS),本进程不该开窗;
    - 非 Windows 平台返回哨兵 True(项目桌面工具只在 Windows 跑,不为没有的需求写代码)。

    ⚠ 为什么不用 QLocalServer.listen 当闸:Windows 上同名命名管道允许多实例,
    listen **总是成功、不报错**(2026-08-31 跨进程实测);而"先探测再 listen"之间
    隔着 QApplication + WebEngine 构造(实测 1-3s),用户"没反应再点一次"正好落进窗口。
    mutex 的创建/查重是内核一步原子操作,没有这个窗口。
    """
    if sys.platform != 'win32':
        return True
    import ctypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.CreateMutexW.restype = ctypes.c_void_p
    h = k32.CreateMutexW(None, False, f'Local\\desktop-shell-{app_id}')
    if h and ctypes.get_last_error() == 183:        # ERROR_ALREADY_EXISTS
        k32.CloseHandle(ctypes.c_void_p(h))
        return None
    if not h:
        # 建不出 mutex(权限之类,几乎不会发生):出声,宁可放行也别把工具锁死在门外。
        print(f'[desktop-shell] 单实例 mutex 建不出来(WinError '
              f'{ctypes.get_last_error()});本次不做双开保护', file=sys.stderr, flush=True)
        return True
    return h


def _try_activate_running(app_id: str, payload: bytes = b'raise') -> bool:
    """已经有一个实例在跑?连上去让它把窗口提到前台,返回 True(本进程该退出了)。"""
    from PySide6.QtNetwork import QLocalSocket
    sock = QLocalSocket()
    sock.connectToServer(app_id)
    if not sock.waitForConnected(300):
        return False
    sock.write(payload)
    sock.waitForBytesWritten(300)
    sock.disconnectFromServer()
    return True


def _listen_for_second_instance(app_id: str, on_raise) -> object | None:
    """守住命名管道;第二个实例连上来就调 on_raise()。返回 server(要保住引用别被 GC)。

    ⚠ 这**不是**单实例闸(闸在 _acquire_single_instance_mutex,Windows 上 listen
    从不失败、拦不住任何人),它只是"叫前台"的消息通道。listen 失败只可能发生在
    Unix(陈旧 socket 文件),removeServer 清掉重试;Windows 上那条分支是不可达的。
    """
    from PySide6.QtNetwork import QLocalServer

    server = QLocalServer()
    if not server.listen(app_id):
        QLocalServer.removeServer(app_id)
        if not server.listen(app_id):
            print(f'[desktop-shell] 命名管道 {app_id} 占不住({server.errorString()});'
                  f'"叫前台"通道缺席(单实例保护本身不受影响,闸在 mutex)',
                  file=sys.stderr, flush=True)
            return None

    def _on_new():
        conn = server.nextPendingConnection()
        if conn is not None:
            def _ready(c=conn):
                data = bytes(c.readAll().data())
                on_raise(data)
                c.disconnectFromServer()
            conn.readyRead.connect(_ready)

    server.newConnection.connect(_on_new)
    return server


def run_desktop(handler_cls, title: str, app_id: str,
                port: int | None = None, smoke: bool = False,
                size: tuple[int, int] = (1560, 980),
                on_activate=None, activate_payload: bytes = b'raise',
                initial_path: str = '/', selftest: str | None = None,
                selftest_timeout_s: float = 600.0) -> int:
    """开窗口跑一个本地网页工具。返回进程退出码。

    ``activate_payload``：本进程抢不到单实例闸时送给已有实例的字节串（缺省 ``raise`` = 只叫前台）；
    ``on_activate(data: bytes, view)``：已有实例收到管道消息时的回调（先叫前台再调它），
    工具用它做「已开着的窗口切到某条资产」；``initial_path``：首次装载的路径（可带 query）。

    ``selftest``：一份 JS 场景脚本的路径。页面 load 完后把它注入真页面里跑（脚本自己把报告串写到
    ``window.__selftestResult``，每行 ``PASS ...`` / ``FAIL ...`` / ``EXC ...``），跑完原样打印，
    有 FAIL/EXC 退出码 1，超时 3。这是交互层的端到端回归门：改了手势 / 异步 / 保存这一层，
    先跑它，别拿审查员当回归测试。selftest 与 smoke 一样无头（offscreen）、不参与单实例。
    """
    smoke = smoke or bool(selftest)
    from PySide6.QtCore import Qt, QTimer, QUrl
    from PySide6.QtGui import QKeySequence, QShortcut
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWidgets import QApplication, QMainWindow

    # 单实例:先抢 mutex(内核原子,无竞态窗口),抢不到再尽力把已有实例叫到前台。
    # 叫不叫得动都**必须退出** —— 已有实例可能还在启动、管道尚未 listen,
    # 这正是旧的"探测→listen"方案里能双开的那 1-3 秒。
    # smoke 是无头自检,不参与单实例(否则 CI 里两条自检会互相踢掉)。
    mutex_guard = None
    if not smoke:
        mutex_guard = _acquire_single_instance_mutex(app_id)
        if mutex_guard is None:
            if _try_activate_running(app_id, activate_payload):
                print(f'[desktop-shell] {title} 已经开着,已把它提到前台', flush=True)
            else:
                print(f'[desktop-shell] {title} 已有实例在跑(可能正在启动中),本进程退出',
                      flush=True)
            return 0

    # WebEngine 硬要求:必须在 QApplication 构造前设,否则直接 crash/黑屏
    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts, True)
    app = QApplication(sys.argv)
    actual_port = start_server(handler_cls, port or 0)

    win = QMainWindow()
    win.setWindowTitle(title)
    view = QWebEngineView(win)
    # ① off-the-record:不给 storageName → 纯内存 profile,零磁盘缓存
    profile = QWebEngineProfile(view)
    # ② 显式双保险
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)
    profile.setPersistentCookiesPolicy(
        QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)
    if smoke:
        # ⚠ 无头自检里 JS 对话框没人点:alert() 在 QtWebEngine 是模态的,会把整个
        #   load 吊死到超时(实测:offscreen 下 WebGL2 拿不到 → app.js 开头
        #   alert('need WebGL2') → loadFinished 永不触发)。smoke 一律吞掉并打印。
        class _SmokePage(QWebEnginePage):
            def javaScriptAlert(self, url, msg):
                print(f'[smoke] js-alert: {msg}', flush=True)

            def javaScriptConfirm(self, url, msg):
                print(f'[smoke] js-confirm(auto-false): {msg}', flush=True)
                return False

            def javaScriptPrompt(self, url, msg, default):
                print(f'[smoke] js-prompt(auto-cancel): {msg}', flush=True)
                return False, ''
        page = _SmokePage(profile, view)
    else:
        page = QWebEnginePage(profile, view)
    view.setPage(page)
    win.setCentralWidget(view)
    win.resize(*size)
    for seq in ('F5', 'Ctrl+R', 'Ctrl+Shift+R'):
        QShortcut(QKeySequence(seq), win, activated=view.reload)

    def _raise_window(data: bytes = b'raise') -> None:
        win.setWindowState(
            (win.windowState() & ~Qt.WindowState.WindowMinimized)
            | Qt.WindowState.WindowActive)
        win.raise_()
        win.activateWindow()
        if on_activate is not None:
            try:
                on_activate(data, view)
            except Exception as e:  # noqa: BLE001 — 回调炸了不许把窗口拖下水
                print(f'[desktop-shell] on_activate 抛错: {e}', file=sys.stderr, flush=True)

    guard = None if smoke else _listen_for_second_instance(app_id, _raise_window)
    if guard is not None:
        win._single_instance_guard = guard          # 保住引用,别被 GC 掉

    if selftest:
        script_src = open(selftest, 'r', encoding='utf-8').read()
        state = {'done': False}

        def _poll() -> None:
            if state['done']:
                return

            def _got(v):
                if state['done']:
                    return
                if isinstance(v, str) and v:
                    state['done'] = True
                    print(v, flush=True)
                    lines = [ln for ln in v.splitlines() if ln.strip()]
                    bad = [ln for ln in lines if ln.startswith('FAIL') or ln.startswith('EXC')]
                    n_pass = sum(1 for ln in lines if ln.startswith('PASS'))
                    print(f'[selftest] {n_pass} passed, {len(bad)} failed', flush=True)
                    QTimer.singleShot(200, lambda: app.exit(1 if bad else 0))
                else:
                    QTimer.singleShot(500, _poll)
            page.runJavaScript('window.__selftestResult || ""', _got)

        def _loaded(ok: bool) -> None:
            print(f'[selftest] loadFinished ok={ok} port={actual_port}', flush=True)
            if not ok:
                app.exit(2)
                return
            page.runJavaScript(script_src)
            QTimer.singleShot(1000, _poll)
        view.loadFinished.connect(_loaded)
        QTimer.singleShot(int(selftest_timeout_s * 1000),
                          lambda: (print('[selftest] timeout', flush=True), app.exit(3)))
    elif smoke:
        def _loaded(ok: bool) -> None:
            print(f'[smoke] loadFinished ok={ok} port={actual_port}', flush=True)
            QTimer.singleShot(300, lambda: app.exit(0 if ok else 2))
        view.loadFinished.connect(_loaded)
        QTimer.singleShot(20000, lambda: (print('[smoke] timeout', flush=True), app.exit(3)))

    path = initial_path if initial_path.startswith('/') else '/' + initial_path
    view.load(QUrl(f'http://127.0.0.1:{actual_port}{path}'))
    win.show()
    return app.exec()
