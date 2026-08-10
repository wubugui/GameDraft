---
target: editor-tools
date: 2026-08-10
session: 头顶闲聊说话人改造（bubble_lines 两档表单）
---

现象: 库里没有这条 —— 动态加表单行时有**两个连着的 Qt 坑**，都表现为整行被压成一条缝
（本例「限定场景」实测 sizeHint 116px、实际只给 34px，控件溢出到下一行），而 model 层测试
全绿、构造冒烟也全绿——**只有离屏截图看得见**。
① `layout.addWidget(w)` 之后 `w` 仍是 `isHidden()`，要等下一轮事件循环才显示，而隐藏项被
QVBoxLayout **整个跳过** ⇒ 容器 sizeHint 当场是 0，同一回合算出来的行高按"零行"给。
② 容器**隐藏期间**加进去的子控件，updateGeometry 不向上传播，重新 show 时中间层不去
invalidate 外层 QFormLayout，行高冻在旧 sizeHint。
证据: ① 最小复现：`addWidget` 不 show → 容器 sizeHint 高 = 0；`w.show()` 后 = 17。
② 隔离实验（QFormLayout → host →[可选中间层]→ rows，隐藏期加 3 行再 show）四格矩阵：
零中间层 63/63 好、零中间层+relayout 63/63 好、**一层中间层 17/63 塌**、一层中间层+relayout
63/63 好 ⇒ 嵌套是放大器、"隐藏期加子控件"才是根因。
护栏（都验过判别力）`test_bubble_speaker_model.py::test_added_scene_row_counts_toward_size_immediately`
（摘掉 `host.show()` 即红）与 `::test_qt_formlayout_row_collapses_without_explicit_relayout`（机制留证）。
建议: 收成 editor-tools 的一条已知坑（布局纪律那节），两句话：**动态加进布局的控件要显式
`show()`**、**按模式切换显隐的容器增删子控件后要自内向外逐层 `updateGeometry` + `invalidate`
+ `activate`**。顺带记一条方法判据——"行高被压塌"这类缺陷 model 层测不出来（1300+ 测试全绿
也照样漏），必须断言 `host.height() >= host.sizeHint().height()` 或直接离屏 grab 截图看；
本轮正是靠截图才发现，两轮 agent 复核都只按代码读没看出来。同类还有 wordWrap QLabel 进
QFormLayout 的 heightForWidth 塌陷，本次改用只读 QLineEdit + tooltip 绕开。
