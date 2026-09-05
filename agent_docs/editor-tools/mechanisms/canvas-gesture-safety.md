---
id: canvas-gesture-safety
title: 画布手势期间的布局与命中区纪律
domain: editor-tools
type: mechanism
summary: 鼠标事件里改布局 = 必现崩溃(队列连接不是解药,要带 context 的单发定时器);屏幕像素定尺的命中区一律留在成员包围盒之外,护栏要断净空余量而不是"没被罩住"
status: active
authority:
  - tools/editor/editors/scene_editor.py#_perform_fit_all
  - tools/editor/editors/scene_editor.py#_group_anchor_point
triggers:
  paths: ["tools/editor/editors/scene_editor.py", "tools/editor/editors/scene_canvas_model.py", "tools/editor/editors/scene_v2/**"]
  topics: [画布手势, mousePressEvent, 拖拽, 命中区, 把手, 组框, resetTransform, 段错误]
  tasks: [改画布拖拽, 加画布把手或标签, 加画布装饰图元, 改画布自动缩放]
verified_by:
  - tools/editor/tests/test_scene_group_canvas_move.py
last_governed: 2026-09-03
---

## 是什么(一句话)

画布手势有两条与"功能对不对"无关、只与**时序**和**屏幕/世界两套尺度**有关的纪律:
在鼠标事件里改布局会**杀进程**,按屏幕像素定尺的装饰命中区会**把实体挡死**——
两者都不是观感问题,也都不会以"报错"的形式出现。

## 权威源(读代码从哪进)

- `tools/editor/editors/scene_editor.py`:`_perform_fit_all` / `_fit_stabilize_step` /
  `_auto_fit_after_layout`(自动 fit 的时序窗口)、`_SceneGroupBox._group_anchor_point`
  (docstring 逐条记了把手位置历次试错与各自的死法)、`_entity_stack_at`(叠放循环点选)。
- 护栏族全在 `tools/editor/tests/test_scene_group_canvas_move.py`。

## 硬契约(违反即 bug)

1. **手势里只做画布内的事。** 图元的 `mousePressEvent` / `mouseReleaseEvent` 里装载属性面板、
   切 QStackedWidget、改标签文本、写状态栏——任何**改布局**的事都会让画布 resize,把
   `resetTransform()` 落进 Qt 的鼠标事件派发栈中间,**必现 SIGSEGV / Bus error(不是偶发)**。
   `fit_all()` 之后自动 fit 仍生效的那段窗口尤其稳定复现。改布局的收尾一律排到下一拍。
2. **队列连接不是解药**:排队的槽会在控件销毁期的 `processEvents()` 里派发,实测照崩。
   排下一拍要用**带 context 对象的单发定时器**(3 参 `QTimer.singleShot`),宿主没了就不触发。
3. **按屏幕像素定尺的命中区(把手/标签/框边描边)一律放在成员包围盒之外。** 换算成世界单位后
   它在缩小的视图里会变得极大,一旦落进包围盒就把实体挡死;而叠放循环点选**刻意跳过**装饰
   图元,挡住就救不回来。留白 = **命中带宽 + 净空**,且**净空本身也要按屏幕像素兜底**:
   只取 `max(写死留白, 带宽)` 会让带子内沿与包围盒**相切**,定义极值的那个成员永远压线;
   净空写死世界值则越缩越薄。
4. **缩放变化必须重新派生这一类几何**——只刷新一半就会出现"框按旧缩放、把手按新缩放"的错配。

## 已知坑

- **护栏要断净空余量,不要断"没被罩住"**:相切时 `contains()` 在边界判 False,
  测试照绿而用户真点落空。样板是"把成员摆进命中区,断言选中/未选中两态都点得到"+
  余量为正的数值断言。
- 这类留白按屏幕像素长大后会盖到**邻组**;净空只管得住自己的成员,要么给屏幕份额设上限,
  要么把它写进该图元的限制清单。
- 把手/标题的位置是**反复试错**收敛的,每一版都有各自的死法:
  改位置前先读 `_group_anchor_point` 的 docstring,别把已被否掉的方案再走一遍。

## 怎么验证

`pytest tools/editor/tests/test_scene_group_canvas_move.py -n0`——崩溃类必须 `-n0`:
xdist 只会报 worker crashed,把 Python 栈丢掉。定罪证据是 Python 栈落在 `_perform_fit_all`
而 C 栈在 `QGraphicsScene::mouseMoveEvent → … → resetTransform`。
