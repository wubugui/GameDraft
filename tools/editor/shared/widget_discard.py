"""丢弃 / 摘除控件的**唯一出口**（PyQt 侧）。

## 为什么必须走这里（2026-09-12 实测事故）

对一个**当前可见**的子控件直接 `w.setParent(None)`，它当场变成一个**顶层窗口**：
Qt 只把 `WA_WState_Hidden` 置上，**不置 `WA_WState_ExplicitShowHide`**（那一位只有
显式 `hide()` 才会置）。于是事件循环回来时——`deleteLater()` 还没落地——Qt 认为这是
一个「该显示的顶层窗口」，把它**显示出来**：屏幕正中弹出一个小窗，标题是
applicationName（本工程即「GameDraft Editor」），任务栏里一个个摞着，直到析构才消失。

实测（雾津街头 `Zone_路遇私铸钱` 的 onEnter，里面的 chooseAction 带条件）：
面板每重载一次就留下**一个**可见的野顶层窗口（414×68，内容是条件树的「Flag 条件」叶子行）；
把摘 parent 改成「先 hide 再摘」，同样 8 次重载 → 0 个。属性差异就是判据：

| 写法 | isHidden | WA_WState_ExplicitShowHide |
|---|---|---|
| 只 `setParent(None)` | True | **False** ← 事件循环回来会被 Qt 再显示 |
| 先 `hide()` 再 `setParent(None)` | True | True |

而编辑器里「面板重载」是家常便饭（换选中实体、切页、主窗重获焦点后的引用目录重建），
所以这个坑的现场表现是「一堆小窗口在屏幕中央光速开关」，且与卡顿互相喂：
每闪一次就抢走又还回一次焦点，而主窗重获焦点又会触发一轮全页重建。

## 两个出口

- :func:`discard_widget` —— 丢弃并销毁（hide → setParent(None) → deleteLater）。
  凡是后面跟着 `deleteLater()` 的摘除一律用它。
- :func:`detach_widget` —— 摘出来**准备重新安家**（重排布局、把控件挪到别的宿主）。
  它**不能** hide：调用方马上要把它 `addWidget` 回去，而显式隐藏过的控件再加进布局
  仍然是隐藏的（整行消失）。代价是：调用方**必须在返回事件循环之前**给它新 parent，
  否则就是上面那个野窗口——所以这里挂了一道 `singleShot(0)` 的事后检查，漏了会在
  控制台喊出来，不让它再退化成「只有肉眼能发现」的 bug。

两个函数都容忍 `None` 与已析构的 C++ 对象（`RuntimeError`），收尾路径不会因此抛。
"""
from __future__ import annotations

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QLayout, QWidget

__all__ = ["discard_widget", "discard_layout_widgets", "detach_widget"]


def discard_widget(w: QWidget | None) -> None:
    """丢弃一个控件：先隐藏，再摘 parent，最后排队销毁。

    顺序不可换（理由见模块文档）：`hide()` 必须在 `setParent(None)` **之前**，
    否则孤儿会在 `deleteLater` 落地之前被 Qt 当成顶层窗口显示出来。

    摘 parent 这一步不是可省的：`deleteLater` 是延后的，只从布局里 removeWidget
    的话，旧控件在事件循环回来之前仍是宿主的 child，`findChildren` 一族的兜底扫描
    会扫到「正在等死」的控件（切页刷新正走这条路）。
    """
    if w is None:
        return
    try:
        w.hide()
        w.setParent(None)
        w.deleteLater()
    except RuntimeError:
        # 底层 C++ 对象已析构：目的已达到
        return


def discard_layout_widgets(layout: QLayout | None) -> None:
    """把一个布局里的控件全部丢弃（清空 `while layout.count(): takeAt(0)` 那一族）。

    嵌套子布局递归处理后一并销毁；spacer 随 item 一起丢。
    """
    if layout is None:
        return
    try:
        while layout.count():
            item = layout.takeAt(0)
            if item is None:
                break
            child = item.widget()
            if child is not None:
                discard_widget(child)
                continue
            sub = item.layout()
            if sub is not None:
                discard_layout_widgets(sub)
                sub.deleteLater()
    except RuntimeError:
        return


def detach_widget(w: QWidget | None) -> None:
    """把控件从当前 parent 上摘下来，**准备马上重新安家**（重排 / 换宿主）。

    与 :func:`discard_widget` 的区别是**不隐藏**：调用方接着就要 `addWidget` 回去，
    而显式 `hide()` 过的控件再加进布局仍然是隐藏的。

    约束（漏了就是屏幕中央的野窗口）：**必须在返回事件循环之前**给它新的 parent。
    这里挂一道事后检查，漏了就在控制台喊一声，不让它退化成只有肉眼能发现的 bug。
    """
    if w is None:
        return
    try:
        w.setParent(None)
    except RuntimeError:
        return

    def _check() -> None:
        try:
            if w.parent() is None and not w.testAttribute(
                    Qt.WidgetAttribute.WA_WState_ExplicitShowHide):
                print(
                    "[widget_discard] detach_widget 之后没有重新安家："
                    f"{type(w).__name__} 现在是个野顶层窗口（会在屏幕中央闪出来）。"
                    "要销毁请改用 discard_widget()。",
                    flush=True,
                )
        except RuntimeError:
            return  # 已析构 = 没问题

    # context 用控件自己：它被销毁 = 这次检查自动取消（销毁本来就不是漏网）。
    # 3 参版是本仓硬护栏，见 tools/editor/tests/test_single_shot_context_parity.py。
    QTimer.singleShot(0, w, _check)
