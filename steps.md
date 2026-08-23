### 5.3 Step 1 — 骨架（约 800 行 / 1.5–2 周）

新建 `tools/editor/editors/scene_v2/`：

- `document.py` — `SceneDocument`：数据引用 + `QUndoStack` + 选择态/悬停态 + `changed(ChangeEvent)` + **`write_target()`**
- `changes.py` — `ChangeEvent` 层次（dataclass），**成对的 `*AboutToBeRemoved` / `*Removed`**，批量优先（带列表），带 property 位掩码
- `commands.py` — `EntityTransformCommand`（带 `id()`/`mergeWith()`）+ 复用 `SceneSnapshotCommand`
- `renderer.py` — `SceneRenderer`：`world_to_screen` / `screen_to_world` / `bounding_rect` / `shape` / **`interaction_shape(item, view_scale)`**（单位一律屏幕像素）
- `items.py` — `EntityItem` 基类（`setAcceptedMouseButtons(Qt.NoButton)` + 接受 hover），子图元账本继承 `PART_TABLE`
- `tools.py` — `AbstractTool` 基类 + `ToolManager`（`QActionGroup` 独占）

**验收（全部离屏可测，无需 QApplication 的部分尽量抽出）**：
1. `write_target()` 的两条分支各有单测（实体被面板打开 → staging；否则 → 模型）；
2. 构造一条 before==after 的 Transform 命令 → 不入栈、不标脏；
3. 连续 10 帧 push 同一手势的命令 → 栈里恰好 1 条；
4. `undo()` 与 `redo()` 各发出一次同类型 `ChangeEvent`；
5. 删除一个实体时，`AboutToBeRemoved` 的订阅者能读到该实体的完整数据。

### 5.4 Step 2 — MVP 画布（约 2200 行 / 3–4 周）

覆盖 §4.8 那一组。**每完成一个 Tool 就能独立验收**（这是这套架构的额外好处：Tool 之间不互相依赖）：

- `SelectTool` → SEL-01…05、SEL-07、SEL-09、DRAG-06
- `MoveTool` → DRAG-01…03、DRAG-05
- `CreateTool` → ADD-01/03、DEL-03
- `PolygonEditTool` → Zone 顶点全套 + 巡逻折线（**双击插点必须有交互级测试**，这是老画布那条 high 级 bug 的直接堵漏）
- 视图过滤 CROSS-03（复用 `PART_TABLE`）+ z 序 CROSS-04（复用 `entity_sort_math.py`）

### 5.5 Step 3 — 面板接线（约 300 行 / 3–5 天）

21 条信号 + 6 个反向 sync 入口对齐。`ScenePropertyPanel` **一行不改**。
**验收**：老画布的属性面板测试（`test_scene_property_scroll_reset.py`、`test_scene_spawn_stale_staging.py` 等）在 V2 宿主下同样通过。

### 5.6 Step 4 — 测试重建（约 1500 行 / 2 周）

实测：四个 glob 下的场景相关测试共 **7730 行**，其中直接摸画布内部（`_canvas.` / `SceneCanvas` / `_entity_items` / `graphics_scene`）的有 **209 处**，集中在 `test_scene_group_canvas_move.py`（101 处）、`test_scene_transform_editing.py`（19）、`test_scene_view_filters_compose.py`（19）、`test_scene_entity_tree_multiselect.py`（17）、`test_scene_canvas_presence_regressions.py`（14）。

- **零改动继续跑**：`test_entity_sort_parity.py`（248 行）、`test_entity_transform_parity.py`（189 行）、`test_perspective_scale_parity.py`——它们测的是 shared 纯函数。
- **需要 V2 版本**：上述 209 处，但**分组相关的 101 处属于二期**，MVP 期只需处理约 108 处。
- **必须新增**：画布双击/右键的交互级测试（老画布完全没有，正是"双击插点不可达"长期未被发现的原因）。

### 5.7 Step 5/6 — 二期、三期与老画布下线

- **Step 5（约 1800 行 / 3–4 周）**：分组全套 + 变换手柄 + 透视深度轴 + 碰撞多边形与透视幽灵 + 多选整批拖动 + 复制/重构接线。**同期执行决策 B 的二期**：面板改即时命令、删 staging 与 commit-on-leave。
- **Step 6（约 600 行 / 2 周）**：光环境曲线 + `TargetSpawnPickerDialog`（`:4015`，唯一复用 `SceneCanvas` 的对话框，被 `timeline_editor.py:57` 导入）迁移。

**老画布可以删除的条件（三条全满足，缺一不删）**：
1. §4 矩阵里标 ✅ 与"二期"的全部功能在 V2 上有等价实现，且各自有测试；
2. `TargetSpawnPickerDialog` 已迁移或已改用独立的轻量 picker 视图 —— 否则删 `SceneCanvas` 会连坐 `timeline_editor`；
3. 导航开关（0-c）指向 V2 已连续运行 ≥2 周无数据事故。

---

