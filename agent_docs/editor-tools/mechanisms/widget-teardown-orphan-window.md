---
id: widget-teardown-orphan-window
title: 控件丢弃：摘 parent 之前必须先 hide
domain: editor-tools
type: mechanism
summary: 对可见控件直接 setParent(None) 会让它变成一个真顶层窗口并被 Qt 显示出来（屏幕中央光速开关的小窗）；销毁走 discard_widget/discard_layout_widgets，重新安家走 detach_widget 且必须同回合安家
status: active
authority:
  - tools/editor/shared/widget_discard.py
triggers:
  paths: ["tools/editor/**", "tools/dialogue_graph_editor/**", "tools/production_workbench/**"]
  topics: [控件销毁, setParent, deleteLater, 野窗口, 面板重建, 布局清空]
  tasks: [清空动态行, 重建表单, 改面板重载, 加可增删的行编辑器]
verified_by:
  - tools/editor/tests/test_widget_discard.py
last_governed: 2026-09-12
---

## 是什么（一句话）

`w.setParent(None)` 把控件变成**顶层窗口**；Qt 只置 `WA_WState_Hidden`、**不置**
`WA_WState_ExplicitShowHide`（那位只有显式 `hide()` 才置）。于是事件循环回来时——
`deleteLater()` 还没落地——Qt 把这个孤儿当成「该显示的顶层窗口」显示出来：屏幕中央
弹出一个标题为 applicationName（本仓即「GameDraft Editor」）的小窗，任务栏里一个个摞着，
直到析构才消失。

## 现场（2026-09-12，制作人报的「一堆顶层窗口光速开关」）

- 复现路径：雾津街头 → 选中 `Zone_路遇私铸钱` → 它的 onEnter 里 `chooseAction` 带条件 →
  面板每重载一次（换选中实体 / 主窗重获焦点后的引用目录重建）就留下一个可见野窗口。
- 那个窗口是 `ConditionExprNodeEditor._rebuild_body` 的 `kind == "flag"` 体
  （`FlagKeyPickField` + 两个 QComboBox + `FlagValueEdit` + 隐藏的 `RichTextLineEdit`，414×68），
  被 `_clear_body()` 的 `setParent(None)` 摘成孤儿。
- A/B/C 实测（真窗口，8 次重选 zone）：原样每次留 1 个；只 `hide()` 不摘 parent 0 个；
  先 `hide()` 再摘 parent 0 个。取第三种（既不闪，又保住「摘 parent 让 findChildren
  扫不到正在等死的控件」那条语义）。
- 它与卡顿互相喂：每闪一次就抢走又还回一次焦点，而主窗重获焦点又会触发一轮全页重建
  （见 [mainwindow-editor-hooks](mainwindow-editor-hooks.md) 契约 6）。

## 硬契约

1. **销毁**一律走 `discard_widget(w)` / `discard_layout_widgets(layout)`
   （`tools/editor/shared/widget_discard.py`）：hide → setParent(None) → deleteLater。
2. **重新安家**（重排布局、把控件挪到别的宿主）走 `detach_widget(w)`：它**不 hide**
   （显式隐藏过的控件再 `addWidget` 回去仍然是隐藏的，整行会消失），代价是调用方
   **必须在返回事件循环之前**给它新 parent。漏了会在控制台喊一声（函数里挂了事后检查）。
3. 生产代码里**不许再出现裸 `setParent(None)`**——护栏是
   `tools/editor/tests/test_widget_discard.py::test_生产代码不许裸调_setParent_None`
   （AST 扫 `tools/**`，注释不算）。这道门才是修法本体：坏写法原先在 12 个文件里重复了
   30 多处，「改对这一处」挡不住下一次照抄。

## 已知坑

- **症状是平台相关的**：Windows QPA 上弹出来，离屏平台不弹。所以测试判据用
  `WA_WState_ExplicitShowHide` 这个状态位（跨平台确定，它就是「Qt 还会不会显示它」的开关），
  **不要**去断言"看得见没有"——那种测试在 CI/离屏上恒绿，等于没有。
- 抓现场的姿势：桌面级顶层窗口采样器（`EnumWindows` 轮询，记类名/标题/所属进程）比
  Qt 事件过滤器可靠——**app 级 `installEventFilter` 收不到 `QEvent.Show`**（实测），
  只有对象级过滤器收得到，而新造的控件装不上过滤器。见
  [live-editor-forensics](live-editor-forensics.md)。
- 组合框的弹出容器（`QComboBoxPrivateContainer`，一个带 `QListView` 的 QFrame）本身就是
  顶层窗口，`topLevelWidgets()` 里一大片是它们——排查时别把它们当成野窗口；判据看
  `isVisible()` 与内容。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/editor/tests/test_widget_discard.py -q -p no:cacheprovider
```

真窗口复现（改动前后对照）：起主编辑器 → 新画布选 `雾津街头` → 反复在
`Zone_路遇私铸钱` / `Zone_夜遇癞子` 之间切选 → 数
`[w for w in app.topLevelWidgets() if w.isVisible()]`，除主窗外应恒为空。
