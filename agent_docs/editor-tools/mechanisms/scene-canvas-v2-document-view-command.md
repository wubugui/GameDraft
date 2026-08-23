---
id: scene-canvas-v2-document-view-command
title: 新场景画布(Document–View–Command)
domain: editor-tools
type: mechanism
summary: 新画布只有一条写入路——工具构造命令、Document 唯一裁决写哪份、命令自己发变更事件;没有 staging 第二层真相,所以"写错副本/撤销撤一半/点一下变脏"没有发生的余地
status: active
authority:
  - tools/editor/editors/scene_v2/document.py
  - tools/editor/editors/scene_v2/commands.py
  - tools/editor/editors/scene_v2/tools.py
  - tools/editor/editors/scene_v2/view.py
triggers:
  paths: ["tools/editor/editors/scene_v2/*"]
  topics: [新画布, scene_v2, Document, Command, 撤销, 工具, 画布架构]
  tasks: [改新画布, 加画布工具, 加实体族, 改撤销语义]
verified_by:
  - tools/editor/tests/test_scene_v2_document.py
  - tools/editor/tests/test_scene_v2_architecture_guard.py
  - tools/editor/tests/test_scene_v2_panel_bridge.py
  - tools/editor/tests/test_scene_canvas_parity_v1_v2.py
last_governed: 2026-08-23
---

## 是什么(一句话)

主编辑器「Scene（新画布）」页 = Document–View–Command 三层（出处：Tiled 编辑器 +
Qt Undo Framework，**不是自创范式**）。与老画布 `scene_editor.py` 并存，
数据同一份 `ProjectModel`。

设计与取舍见 `artifact/Design/场景画布重建-方案书-2026-08-23.md`。

## 硬契约(违反即 bug)

### 1. 写入只有一条路：Tool 构造 Command → Document

View 与 Tool 对数据**只读**。想改数据只能构造命令交给 `Document.push()`。
静态护栏 `test_scene_v2_architecture_guard.py` 会拦下工具/图元层里对场景数据的
下标赋值 —— **它不依赖人的记性**，这是架构不退化的唯一保证。

### 2. `Document.write_target()` 是唯一裁决点

"这次写哪一份数据"只在这一个函数里判断。**命令自己也不判断。**
第二处实现出现即红（护栏有断言）—— 那正是老画布的根因。

### 3. 手势期间不写数据

工具只记自己的拖动状态，release 时一条命令落地。所以：
- Esc 中途取消**不需要**反算增量回滚（数据压根没被改过）；
- 零位移点击**不需要**防伪脏闸（零变更根本构造不出命令）。

### 4. `redo()` 与 `undo()` 只差喂进去的那张值表

写入 / 标脏 / 发事件逐字一致。"正着改能刷新、撤回来不刷新"写不出来。

### 5. 图元不吃鼠标，命中走白名单

全部 `NoButton`。命中由工具在一处白名单里决定（只认 `EntityItem`）。
覆盖物（选中框、组框、透视轴）**结构上**不可能抢走点击，
z 因此回归纯显示属性、不再兼职承载"这一下派给谁"。

### 6. 显隐是 `_sync_entity()` 的最后一行

不是一个"需要记得调"的独立函数。任何重建路径都不可能把过滤结论冲掉。

### 7. 属性面板的 staging **不是**第二层真相

复用老面板（一行不改），但 `PanelBridge.staging_dict_for` 恒返回 None ——
Document 永远写模型。面板编辑经桥变成命令。
返回 staging 会让"两层真相"整套问题原地复活。

## 已知坑

- **命中尺寸一律屏幕像素**，且**封顶**：手柄/命中带永不超过所依附之物的四分之一。
  不封顶时缩到 0.04 倍会算出 225 世界单位的命中带，把整个框连同周围全吞掉；
  不换算则缩小后顶点只剩 3 像素点不中。两个方向都坏过。
- **叠放循环点选是纯列表轮转，一个 z 都不动**。老画布靠临时抬 z，代价是抢走
  gizmo 手柄的按下。
- **包围盒不要用 `QRectF.united` 逐个并**：点实体的矩形是零尺寸，Qt 当 null 丢掉，
  一组点实体的包围盒会塌成最后一个成员。
- **命令合并的 `id()` 恒定**，"第一帧不合并"靠 `mergeWith` 查**来者**的标志位。
  把第一帧的 id 写成 -1 看着合理，实际是后续帧没有东西可以并进去。
- **`_MISSING` 哨兵**区分"键原本不存在"与"值是 None"：撤销把不存在的键补成 None
  是数据污染，黄金往返会红。
- **删除撤销要回原数组下标**：数组序是运行时平局排序的依据。
- 新增实体族要同时改：`document._LIST_KEY`、`commands_structure.LIST_KEY`、
  `view._PART_ITEM_FACTORY`、`scene_canvas_model.PART_TABLE`。

## 并存期(两个画布同时活着)

- 场景页清单只有一处：`tools/editor/scene_page_registry.py`。跳转落点由
  `NAV_TARGET` 单一开关决定，**同一时刻只有一个页可被导航到**。
- 撤销栈跨页知会：`scene_undo.broadcast_external_scene_write`。
  代价是**切页 = 另一页撤销栈清空** —— 语义诚实，好过两个栈互撤。
- 切页时按模型重载，防止另一页拿旧 staging 快照把模型拍回去。
- 两个画布的**内容层次序必须一致**，护栏 `test_scene_canvas_parity_v1_v2.py`。

## 怎么验证

`test_scene_v2_document.py`（五条架构验收）、`test_scene_v2_architecture_guard.py`
（不退化）、`test_scene_v2_tools.py` / `test_scene_v2_overlays.py`（交互级）、
`test_scene_v2_panel_bridge.py`（面板不是第二层真相）、
`test_scene_canvas_parity_v1_v2.py`（新老次序一致）。
