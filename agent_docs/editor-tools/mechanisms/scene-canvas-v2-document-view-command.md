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
  - tools/editor/tests/test_scene_new_scene_entry.py
  - tools/editor/tests/test_scene_page_reload_on_nav.py
  - tools/editor/tests/test_scene_v2_external_writes.py
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

- **图元账本是纯 push 的,对"不发事件的外部写入"零感知**(老画布删除/快照撤销、点选器、
  自动化任务都可能直写模型)。后果是**幽灵图元**:画面上还在、**还能点中**,显隐同步对查不到
  的实体一律显示,再删走安全删除还反报"场景里没有这个实体"。**重开才消失** = 这条的典型主诉。
  所以外部写入必须由文档层触发重投影(见「并存期」两道防线),不能指望账本自己发现。
- **改 id 是换身份,不是改一个字段**:命令持有的引用必须**跟随**改名,变更事件要**同时带旧、新
  两个引用**。否则实体从画布上消失、撤销按旧 id 找不到人**静默无效**——与幽灵图元同根。
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
- **命中要按真实形状，不是包围盒**（`EntityItem.pick_contains`）。三角 Zone 的
  AABB 有一半在形外,拿包围盒判定 = 点空白处选中一个大区域,还把叠在上面的小
  实体一并压过去。
- **z 相等时命中要有确定的兜底次序**(面积小者优先)。装饰层 z 是同一个常量,
  只按 z 排的话次序取决于图元账的迭代顺序 —— 那是"上次谁被重建过"的副产物,
  同一处点两次可能选中不同实体。
- **零位移的那一维要原值返回**。整组位移对每个成员的 x 与 y 是无条件同时写的,
  纯水平拖动时 dy 恒为 0;这一支若仍走 `round(v, 1)`,全组的 y 会被静默截断
  (218.02 → 218.0)。真实场景里几百个 float 坐标一次拖动就被改脏。
- **碰撞面的"画"与"写"必须是同一对互逆变换**
  (`shared/scene_migrations` 的 `collision_polygon_local_to_world` /
  `..._world_to_local`)。画只做 `anchor + local`(漏掉实例 transform)、写走完整
  反变换时,`scale != 1` 的实体上顶点一松手就跳走,且越拖越远。
- **视图轴只管辖 `FILTERED_KINDS`**(热点/NPC/区域)。出生点、光曲线这些结构件
  没有 `planes` 键,与实体走同一条判定就会落进"缺省实体在 exclusive 位面里不存在"
  那一支 —— 一切到梦境位面,出生点全体消失。
- **场景级图元不在任何 `entity_refs` 里**:`rebuild_all()` 必须显式同步
  `EntityRef("scene", sid)`,否则光环境曲线只在收到一次 scene 变更事件后才凭空
  出现(= 打开场景时看不见也编辑不了)。
- **场景级 part 的数据形状不必是点列。** 第一个场景级 part(光环境曲线)恰好是点列,
  于是同步那一支写成了"一律喂 `set_points`";曾有过的轨迹 part 喂的是**整张轨迹表**,只能早退改喂
  整份场景数据(轨迹 2026-09-04 已迁出场景画布,见 [[trajectory-workbench]];这条经验对下一个非点列的
  场景级 part 仍成立)。更要紧的是:**"当前编哪条 / 哪段 / 洗刷到哪一刻"是视图状态,由工具持有,
  `_sync_*` 只喂数据、绝不能顺手重设** —— 重设 = 别的实体一变更就把作者正在编的段踢掉。
  下一个场景级 part 别再照点列那支抄一遍。
- **`PolygonEditTool._target_parts` 的产出顺序即优先级**:选中实体的点列必须排在
  场景级光曲线之前。曲线控制点的命中半径是 10 屏幕像素,排前面就会把正下方
  选中实体的顶点拖拽整个抢走 —— 拖拽/双击插点/右键删点三条路径一起错。

## 面板桥：三条与直觉相反的规则

老面板一行不改地复用，代价是它的既有行为要由桥这一侧扛住。三条都踩过：

- **提交前必须 `flush_active_panel_widgets_to_staging()`**。老面板绝大多数控件
  只调 `_emit_props_changed()`(置脏 + 发信号),**不写 staging**。少了这一步,
  桥读到的永远是载入时的深拷贝、diff 恒为空,改标签/改类型/取消勾选全部静默丢失。
- **`commit_panel_edits()` 不可重入**。上面那个 flush 内部会调 `_emit_props_changed()`,
  正是把 commit 接上去的那个信号 —— 不挡就是无限递归,进程**栈溢出硬崩**(不是抛异常)。
- **数值只比大小、不比 int/float 表示**,且**空值不当新增**。staging 是穿过控件的
  投影(spinbox 一律吐 float,x/y 实时回写硬编码 `float(...)`),按表示判定会让
  "只改了 x"顺手把 y 写成 `320.0`;把空文本框的 `""`、空表的 `{}` 当新增,则
  **光是选中一个实体**就产生一条命令、给数据加上 `label: ""`(本仓约定缺省不落键)。
  注意 bool 要单独挡在数值比较之前 —— Python 里 `True == 1`。

## 手势预览：一条通道，不要每个工具各写一套

拖动/框选/gizmo 的**过程**画面全走 `SceneView.refresh_gesture_preview()`,
它只读工具的几个可选属性(`band_rect` / `drag_offset` + `dragging_refs` /
`transform_preview` / `gizmo_positions()`)。每个工具各写一套预览的下场是各有各的
漏画 —— 本轮实测:橡皮筋画了、拖动没画、gizmo 干脆一个像素都没有。

位置拆成**数据位**(`set_base_pos`,只由 `_sync_*` 写)+ **预览位移**
(`set_preview_offset`,只由手势写)。合成一个 `setPos` 的话,手势中任何一次同步
都会把预览冲掉;反过来若同步读回带位移的 pos,预览就被**当成真实几何**烘进数据。

## "有提示没接线"是这个画布的固定病灶

状态栏/文档写了、代码一个调用点都没有的功能,本轮一次性清出五条:橡皮筋覆盖物、
拖动与变换预览、右键删顶点、方向键微移、Delete/Ctrl+D。成因都一样:**画布的
键盘与右键路径没有测试**。新增任何"提示里承诺的交互",同一轮必须补一条从
真实入口进的用例。

顺带两条容易漏的接线:
- `SceneView` 要 `setFocusPolicy(StrongFocus)`,否则 `QGraphicsView` 默认不接受
  点击取焦,`keyPressEvent` 一个事件都收不到。
- Delete / Ctrl+D / 方向键作用在**当前选择**上,不属于任何工具 —— 接在
  `AbstractTool.key_pressed` 基类,免得"换个工具就删不了"。

## 并存期(两个画布同时活着)

- 场景页清单只有一处：`tools/editor/scene_page_registry.py`。跳转落点由
  `NAV_TARGET` 单一开关决定，**同一时刻只有一个页可被导航到**。
- 撤销栈跨页知会：`scene_undo.broadcast_external_scene_write`。
  代价是**切页 = 另一页撤销栈清空** —— 语义诚实，好过两个栈互撤。
- **并存靠两道防线,两道都要各自成立,少一道就是幽灵图元**:
  ① **切页重载必须挂在导航树的"当前项变化"上**,不能只挂跳转/历史那条路——
  手点导航树切页不经过跳转路径,只挂那儿等于"用跳转进得来的页是新的、手点进来的是旧的"。
  ② **收到外部写入知会时,文档层要重投影(发一次"已重载"),不能只清撤销栈**。
  老画布侧**刻意不做**"写入即重投影":它的加载路径会先把 pending flush 成命令再广播,
  反过来清掉新画布的栈;老画布只靠切页重载。
- 两个画布的**内容层次序必须一致**，护栏 `test_scene_canvas_parity_v1_v2.py`。
- **新建场景**两边都有入口（左栏「+ 新建场景」），而 id 准入判定与最小骨架只有
  `shared/scene_ids.py` 一份(`scene_id_problem` / `new_scene_skeleton`)。新画布起初
  没有这个入口(工程没场景时整页什么都做不了)；老画布则曾用「仅字母数字下划线」
  的正则把占多数的中文场景 id 拦在门外 —— norms 不变量 7(Python 兜底不得比运行时更严)
  的典型违例。约束只从 id 真正会变成的东西反推：文件名 / `sceneId:groupId` 限定引用 /
  `--scene` 命令行参数。场景的创建**不入撤销栈**(Document 按场景建，与老画布同口径)。
  护栏 `test_scene_new_scene_entry.py`(从按钮进、两个画布互见)+ `test_scene_ids.py`。

## 怎么验证

`test_scene_v2_hit_and_preview.py`（形状命中 / 手势预览 / 键盘快捷键）、
`test_scene_v2_document.py`（五条架构验收）、`test_scene_v2_architecture_guard.py`
（不退化）、`test_scene_v2_tools.py` / `test_scene_v2_overlays.py`（交互级）、
`test_scene_v2_panel_bridge.py`（面板不是第二层真相）、
`test_scene_canvas_parity_v1_v2.py`（新老次序一致）、
`test_scene_new_scene_entry.py` / `test_scene_ids.py`（新建场景入口与 id 准入，新老共用）。
