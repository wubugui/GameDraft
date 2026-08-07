---
target: missing
date: 2026-08-07
session: 场景分组画布代理框 + 整组位移
---

现象: 在画布图元的 `mousePressEvent` / `mouseReleaseEvent` 里做任何**改布局**的事（装载属性面板=切 QStackedWidget、QLabel.setText、状态栏提示），会让画布 resize → `SceneCanvas._perform_fit_all()` 的 `resetTransform()` 落在 Qt 的鼠标事件派发栈中间执行，**必现 SIGSEGV / Bus error**（不是偶发）。窗口在 `fit_all()` 之后 320ms 内（`_auto_fit_after_layout` 仍为 True）尤其稳定复现。
证据: `pytest tools/editor/tests/test_scene_group_canvas_move.py -q -n0` → `Fatal Python error: Segmentation fault`；Python 栈 `_perform_fit_all ← _fit_stabilize_step`，C 栈 `QGraphicsViewPrivate::mouseMoveEventHandler → QGraphicsScene::mouseMoveEvent → … → Sbk_QGraphicsViewFunc_resetTransform`。解法：手势里只做画布内的事，一切改布局的收尾经 `QTimer.singleShot(0, self, ...)`（3 参版）排到下一拍。
建议: 库里缺一张「画布手势期间不得改布局」的机制卡；顺带记上：QueuedConnection 不是解药（排队的槽会在控件销毁期的 processEvents 里派发，实测 Bus error），带 context 对象的 singleShot 才是。
