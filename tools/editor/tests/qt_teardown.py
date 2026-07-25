"""测试进程里真正销毁 Qt 控件的收尾动作。

被 ``conftest.py`` 的 autouse fixture 每个测试调一次；``test_qt_widget_teardown.py``
把「它真的能销毁」这件事钉成护栏。
"""
from __future__ import annotations

import gc
import sys
import warnings


#: 等一个还在跑的后台线程最多等多久（毫秒）。这些 ``run()`` 里都没有 ``exec()``，
#: ``quit()`` 是空操作，只有 ``wait()`` 管用；带上限免得测试被卡死。
THREAD_WAIT_MS = 10_000

#: 打在"线程等不回来、已放弃销毁"的控件上，避免之后每轮收尾都重复空等。
_ABANDONED_PROP = "_gamedraft_teardown_abandoned"


def destroy_leftover_qt_widgets() -> None:
    """销毁本进程里所有遗留的顶层 QWidget（连带它们的子树）。

    测试里常见的 ``ed.deleteLater(); QApplication.processEvents()`` **一个控件都销毁
    不掉**：``deleteLater()`` 只是投递 ``DeferredDelete`` 事件，而测试进程没有事件
    循环（loopLevel 0），``processEvents()`` 不投递该事件。这里显式
    ``sendPostedEvents(None, DeferredDelete)`` 才真收得掉。

    没有本函数时控件从第一个测试一直堆到最后一个（实测会话末存活 QWidget 数万、
    RSS 2.2GB），而 ``theme.apply_application_theme()`` 里的 ``app.setStyleSheet()``
    是全应用重刷、成本正比于存活控件数 —— 全套 823s 里 713s 耗在那 5 个调用
    ``apply_application_theme`` 的测试上，纯 O(N²)。收干净后全套 ~170s。

    **已知边界**：只看得到挂在顶层控件下的 QThread（``findChildren``）。测试若自己造了
    ``parent=None`` 的 QThread 并 ``start()``，它被 gc 回收时仍在跑 → 一样 abort。
    这类线程得测试自己 ``wait()`` 收尾。（不做全进程 ``gc.get_objects()`` 扫描：那要
    遍历几十万对象，每个测试一次会把本函数省下的时间全吃回去。）
    """
    # 没 import 过 Qt 的测试进程（chronicle_sim 等）不该被这层收尾拖去 import PySide6。
    if "PySide6.QtWidgets" not in sys.modules:
        return
    from PySide6.QtCore import QCoreApplication, QEvent, QThread
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    if app is None:
        return
    for widget in list(app.topLevelWidgets()):
        # 上一轮已经放弃过的控件不再重复 wait——否则一个卡死线程会让之后**每个**测试
        # 的收尾都白等 THREAD_WAIT_MS，把刚干掉的 O(N²) 换成 O(N)×10s。
        if widget.property(_ABANDONED_PROP):
            continue
        # QThread 在仍然 isRunning() 时被析构 = qFatal → 整个 pytest 进程 SIGABRT
        # （xdist 下是整个 worker 崩，同 worker 余下的测试全报 worker crashed，
        # 现场极难反查）。所以先把后台线程等回来；**等不回来就不销毁这个控件**——
        # 泄漏一个控件远比整进程 abort 便宜，而且测试还能继续跑完。
        stuck = [
            thread
            for thread in widget.findChildren(QThread)
            if thread.isRunning() and not thread.wait(THREAD_WAIT_MS)
        ]
        if stuck:
            names = ", ".join(sorted({type(t).__name__ for t in stuck}))
            widget.setProperty(_ABANDONED_PROP, True)
            warnings.warn(
                f"{type(widget).__name__}: 后台线程 {names} 等待 "
                f"{THREAD_WAIT_MS}ms 仍在运行，放弃销毁（该控件此后一直泄漏）。"
                "测试应自己把线程停下来再结束。",
                RuntimeWarning,
                stacklevel=2,
            )
            continue
        widget.deleteLater()
    # 析构过程本身还会再投递 DeferredDelete（子对象在析构函数里 deleteLater），
    # 且 Python 侧引用要等 gc 才放，故收两轮。
    for _ in range(2):
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        gc.collect()


def live_widget_count() -> int:
    """当前进程存活的 QWidget 数；没起过 QApplication 返回 0。"""
    if "PySide6.QtWidgets" not in sys.modules:
        return 0
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    return 0 if app is None else len(app.allWidgets())
