"""单实例守卫：整个系统里只允许一个构建工作台。

## 为什么守卫要在工作台自己身上

启动它的地方不止一处：主编辑器的按钮、开机自启、`npm run build:gui`、双击。
把"别开第二个"做在其中某一处，剩下几处照样能开出第二个来。做在被启动的一侧，
不管谁来启动，行为都一致：**第二个进程把第一个唤到前台，然后自己退出**。

两个实例同时跑的后果不是"多个窗口"这么轻：它们各自有一个调度定时器，
到点会**同时**起两次构建，写同一个构建根目录、抢同一个输出目录。

## 为什么用 QLocalServer 而不是文件锁

文件锁只能回答"有没有别人在跑"，回答不了"把它叫到前台来"——而后者才是用户
按下那个按钮时真正想要的。命名管道两件事一起办：连得上就说明有人在，
顺手把"请现身"这句话递过去。

Windows 上是命名管道（按登录会话隔离，所以"整个系统"实际是"当前用户的会话"，
这也是对的——另一个用户登录时不该被你的工作台挡住）。
"""
from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import QObject, Signal
from PySide6.QtNetwork import QLocalServer, QLocalSocket

#: 管道名。改它等于换一把锁——旧版本的实例会认不出新版本，于是能开出两个来。
SERVER_NAME = "GameDraftBuildWorkbench.v1"

#: 连接/收发的超时。本机管道，正常都是毫秒级；给足余量但不至于让人干等。
_TIMEOUT_MS = 1500
#: 收下连接后等数据落进缓冲区的时间。正常是零等待——字节早就在操作系统那儿了。
_READ_TIMEOUT_MS = 300


class SingleInstanceGuard(QObject):
    """先 `try_notify_existing()`，没人应答再 `acquire()`。"""

    #: 另一个实例请求现身；payload 是它带来的信息（目前是它想打开的工程路径）
    activate_requested = Signal(dict)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._server: QLocalServer | None = None

    # -------------------------------------------------------------- 客户侧

    @staticmethod
    def try_notify_existing(project_root: Path) -> bool:
        """已经有实例在跑就把它叫到前台，返回 True（调用方应当直接退出）。

        连不上有两种情况，这里一律当作"没人在跑"：真的没人，或者上一个进程崩了
        留下了名字。后者由 `acquire()` 里的 `removeServer` 收拾。
        """
        sock = QLocalSocket()
        sock.connectToServer(SERVER_NAME)
        if not sock.waitForConnected(_TIMEOUT_MS):
            return False
        payload = json.dumps({"projectRoot": str(project_root)}, ensure_ascii=False)
        sock.write(payload.encode("utf-8"))
        sock.flush()
        sock.waitForBytesWritten(_TIMEOUT_MS)

        # **等对面回一声再走。**
        #
        # 不等的话消息会丢：Windows 的命名管道在客户端断开时，会把服务端还没读走的
        # 数据一起丢掉（实测如此——服务端 `waitForReadyRead` 一路超时，读到空）。
        # 而本进程紧接着就要 `return 0` 退出，等于"我说了但没人听见"，
        # 却还报告了"已唤到前台"。
        #
        # 有了这一声，返回值才名副其实：True = 对面**确实收到了**。
        got_ack = sock.waitForReadyRead(_TIMEOUT_MS) and bytes(sock.readAll()).startswith(b"ok")
        sock.disconnectFromServer()
        return got_ack

    # -------------------------------------------------------------- 服务侧

    def acquire(self) -> bool:
        """占住这个名字。返回 False = 已经有人在跑，或者占不住。

        **判据是"有没有人应答"，不是"listen 成不成功"。** 实测：Windows 上同名
        命名管道可以开出第二个实例，第二个 `listen` 照样返回 True——只靠它判断的话
        两个进程都会以为自己是主实例，各跑一个调度定时器，到点同时起两次构建、
        抢同一个输出目录。

        探测失败之后才 `removeServer`：那时名字要么没被占，要么是上个进程崩掉留下的
        死名字（POSIX 上是个残留的 socket 文件）。活着的名字绝不去抢。
        """
        probe = QLocalSocket()
        probe.connectToServer(SERVER_NAME)
        if probe.waitForConnected(_READ_TIMEOUT_MS):
            probe.abort()
            return False  # 真有人在跑，老老实实退让
        QLocalServer.removeServer(SERVER_NAME)

        server = QLocalServer(self)
        if not server.listen(SERVER_NAME):
            return False
        server.newConnection.connect(self._on_new_connection)
        self._server = server
        return True

    def release(self) -> None:
        if self._server is not None:
            self._server.close()
            QLocalServer.removeServer(SERVER_NAME)
            self._server = None

    def _on_new_connection(self) -> None:
        """收下连接，**不在这里阻塞等数据**。

        原来这里写的是 `waitForReadyRead`，那是错的：槽函数里阻塞会把调用方
        一起卡住。客户端与服务端在同一个线程时（单元测试就是），客户端正压在
        我们下面的调用栈上等 `waitForConnected` 返回，它要等我们返回才能开始写，
        而我们在等它写——谁也动不了，最后超时，载荷丢掉。
        表现是"服务的是另一个工程"那句提示永远出不来。

        改成信号驱动：收下连接就返回，数据到了由 `readyRead` 叫醒。
        """
        if self._server is None:
            return
        sock = self._server.nextPendingConnection()
        if sock is None:
            return

        done = False

        def finish(payload: dict) -> None:
            nonlocal done
            if done:
                return
            done = True
            self.activate_requested.emit(payload)
            sock.deleteLater()

        def on_ready() -> None:
            raw = bytes(sock.readAll()).decode("utf-8", "replace")
            payload: dict = {}
            try:
                loaded = json.loads(raw)
                if isinstance(loaded, dict):
                    payload = loaded
            except (ValueError, TypeError):
                pass  # 对面说了什么听不懂也照样现身——它的意图很明确
            # 回一声，对面才敢断开（见 try_notify_existing 里那段）
            sock.write(b"ok")
            sock.flush()
            sock.waitForBytesWritten(_READ_TIMEOUT_MS)
            finish(payload)

        def on_disconnected() -> None:
            # **断开时先把缓冲区里剩的话读完。** 对面写完就 disconnect，
            # 两个信号到达的先后不保证；直接当"没说话"处理会把载荷丢掉。
            if sock.bytesAvailable() > 0:
                on_ready()
            else:
                finish({})

        sock.readyRead.connect(on_ready)
        sock.disconnected.connect(on_disconnected)

        if sock.bytesAvailable() > 0:
            on_ready()
            return
        # 数据还没进 Qt 的缓冲区：给一小段时间把它拉进来。
        #
        # 这里敢阻塞，是因为走到这一步时对面**不在我们的调用栈上**——`newConnection`
        # 是在客户端那次调用返回之后才送达的（实测如此）。等的是操作系统缓冲区里
        # 已经躺着的字节，不是等对面现写，所以正常是零等待返回。
        # 超时也不要紧：readyRead / disconnected 两条后路还在。
        if sock.waitForReadyRead(_READ_TIMEOUT_MS):
            on_ready()
