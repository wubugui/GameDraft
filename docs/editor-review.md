# 编辑器实现漏洞 Review

> **说明（运行时对话已去 Ink 化）**：游戏内 NPC 对话以 **`public/assets/dialogues/graphs/*.json`** 为准；主编辑器若已移除 Ink 对话页，下列与 **DialogueBrowser / Ink 高亮** 相关的条目仅作**历史审查记录**，不代表当前必现问题。

## 数据完整性

### NextQuestsEditor 删除边时索引漂移

在 quest_editor.py 的 `_NextQuestsEditor._remove_edge` 方法中，`_edges.pop(min(i, len(self._edges) - 1))` 使用了 `_row_widgets` 中的索引 `i` 来删除 `_edges` 中的元素。问题是 `_add_row` 中 lambda 闭包捕获的 `idx` 参数在后续删除操作中不会重新编号，如果中间某行已删除但 frame 引用仍保留，`_edges` 会删错元素。应该始终使用从 `_row_widgets` 中找到的真实索引 `i`，而不是闭包中过时的 `idx`。

### TargetSpawnPickerDialog 静默创建默认出生点

在 scene_editor.py 的 `_reload_all` 方法中，打开一个没有 `spawnPoint` 的场景时会自动创建一个默认出生点（位于世界中心）并标记场景为 dirty。这个行为没有向用户发出任何提示，且 undo stack 不会记录这个变更。用户在不知道的情况下修改了场景数据。更严重的是，多次打开不同场景会在每个没有 `spawnPoint` 的场景里都创建默认出生点，用户只有在 Save All 后才会发现。

### Cutscene Editor 不校验 ID 唯一性

CutsceneEditor 的 `_apply` 方法只校验命令内容，不检查 cutscene ID 是否与其他 cutscene 重复。用户可以手动修改某个 cutscene 的 ID 为已存在的值，系统不会发出任何警告。游戏运行时通过 `cutscenes.find(c => c.id === x)` 查找 cutscene 会返回不确定的结果（取决于数组遍历顺序），导致过场动画加载到错误的配置。

### 锁比例修改 worldWidth/Height 后数据可能丢失

ScenePropertyPanel 中修改 worldWidth 时（锁定比例模式下）会自动计算并设置 worldHeight 的 spinbox 值。但 `save_scene_props` 需要用户点 Apply 或 Save All 才会写回模型。在此期间如果切换场景（`load_scene_props` 会覆盖 widgets），比例的中间变更就丢失了。而用户看到 UI 上显示了新的数值，会误以为已经生效。

## UI 交互逻辑

### Transition spawn picker 连续弹出模态框

ScenePropertyPanel 的 `_on_trans_scene_changed` 中，选择目标场景后用 `QTimer.singleShot(0, self._open_trans_spawn_picker)` 延迟弹出出生点选择对话框。这个设计是为了避免 Combo 下拉关闭与模态框打开在同一事件循环中产生冲突。但如果用户快速切换多个 targetScene，每次切换都会产生一个 `singleShot` 排队，导致连续弹出多个出生点选择对话框，用户需要逐一关闭。

### DialogueBrowser 切换文件时静默保存（历史；Ink 对话页若已移除则不再适用）

DialogueBrowser 的 `_load_ink_file` 在切换 Ink 文件时，若当前文件有未保存变更会直接 `_do_save()`，无确认弹窗。若项目已不再内置 Ink 对话编辑，本条仅保留为旧版行为记录。

### FilterableTypeCombo 空匹配时行为反直觉

ActionEditor 的 `FilterableTypeCombo._on_text_edited` 中，当用户输入的文字在候选项中完全匹配不到时，下拉列表会回退到显示全部条目。同时 `lineEdit` 中保留用户输入的原文。这导致用户看到的是一个被筛选过的空结果列表突然变成了全量列表，而输入框里显示的文字又不在列表中，容易让用户误以为输入已被接受。

### ActionRow._normalize_action_params 直接修改传入的 dict

`ActionRow` 构造函数中对 `raw.get("params", {})` 做了浅拷贝后传给 `_normalize_action_params`，这个方法会 `pop` 旧字段名并写入新字段名（如 `sceneId` → `targetScene`）。浅拷贝意味着如果 params 内包含嵌套对象（如 `addDelayedEvent` 的 `actions` 数组），嵌套对象仍与原始数据共享引用。后续 `to_dict()` 序列化出的结构与原始数据不完全一致，可能导致保存后的 JSON 中嵌套 action 的字段名被意外修改。

### ConditionEditor.to_list 来回序列化丢失默认值

`ConditionRow.to_dict()` 在 op 为 `==` 且 value 为 `true` 时省略 `value` 字段（因为是默认值），返回 `{"flag": "key"}`。`ConditionEditor.to_list()` 过滤掉空 flag 后产出这个精简 dict。如果随后用 `set_data()` 重新加载这个精简 dict，`ConditionRow` 构造时 `data.get("value", True)` 会正确恢复为 `True`。但问题在于 `to_list()` 中对 `r.to_dict()` 调用了两次——每次调用都执行相同的构建逻辑，性能浪费且如果 `to_dict()` 有副作用会产生不一致。

### RuleSlotsParamEditor._remove_row 缺少二次调用保护

`RuleSlotsParamEditor._remove_row` 中先用 `if rec in self._rows` 检查然后 `self._rows.remove(rec)`，但如果按钮被快速点击（在 `deleteLater` 执行前的窗口期），`rec` 可能已被标记为待删除但仍存在于 `_rows` 中（Python 列表不会自动移除）。虽然这种情况较难复现，但缺少 `try/except ValueError` 保护意味着一旦触发会导致未捕获异常。

## Validator 覆盖不全

### execute_action 命令未被校验

Validator 的 `_validate_flags` 遍历 cutscenes 的 commands 时，只对 `set_flag` 类型的命令做 flag key 校验。`execute_action` 命令包含 `actionType` 和 `params`，这两个字段与 ActionRegistry 中的 action 完全一致，但 validator 没有检查 `actionType` 是否在 ACTION_TYPES 中登记，也没有检查 `params` 中的 flag key。Validator 在 `_walk_action_defs` 中能递归检查 `enableRuleOffers` 和 `addDelayedEvent` 的嵌套 action，但没有处理 cutscene 的 `execute_action`。

### Validator 未校验 cutscene 中 switch_scene/change_scene 的 sceneId 目标

Validator 对 scene 数据中的 hotspot transition 做了 targetScene 存在性检查，对 map 节点的 sceneId 做了检查，但没有检查 cutscene 命令中 `switch_scene` 和 `change_scene` 的 `sceneId` 是否指向有效场景。一个被删除的场景如果仍被 cutscene 引用，validator 不会报错。

## 画布与渲染

### SceneCanvas.clear_scene 后 Qt 对象残留

`SceneCanvas.clear_scene` 调用 `self._gfx.clear()` 从 QGraphicsScene 中移除所有 items，然后清空 `_entity_items` 和 `_patrol_overlays` 字典。但 `_DraggableCircle`、`_EditableZonePolygon` 等 QGraphicsItem 派生类如果被外部持有引用（如 property panel 中的 `_pending_hotspot` 指向同一个 scene dict），这些 Python 对象不会被垃圾回收。Graphics 对象也没有显式调用 `deleteLater()`，可能残留在 Qt 事件队列中等待延迟删除。在频繁切换场景的编辑过程中，这些对象会逐渐累积。

### NPC 巡逻预览状态与真实 NPC 位置竞争

`_patrol_preview_advance` 方法在巡逻预览模式下独立维护 NPC 的位置（`_patrol_preview_state` 字典），与 scene dict 中的真实 x/y 分开。当 `_on_npc_xy_live_changed` 触发时（用户在侧栏修改 NPC 坐标），如果该 NPC 不在 `patrol_preview_ids` 中，会调用 `rt.draw_at` 使用 scene dict 中的新坐标绘制。但如果巡逻预览恰好在同一 tick 中运行，`_tick_scene_npc_anims` 会用 `_patrol_preview_state` 中的旧坐标覆盖绘制结果。两个绘制源在同一个 `QGraphicsPixmapItem` 上竞争，用户可能看到 NPC 在预览位置和编辑位置之间闪烁。

### _DraggableQuestTree.dropEvent 使用 currentItem 而非拖拽源

`_DraggableQuestTree.dropEvent` 中通过 `self.currentItem()` 获取被拖拽的项。Qt 的拖拽机制中 `currentItem` 是键盘焦点所在的项，不一定是鼠标拖起来的那个项。如果用户先点击选中了 A 任务，然后从列表中的 B 任务开始拖拽，`currentItem()` 返回 A 而非 B，导致实际被移动的是 A 而不是 B。

## 数据模型与 Undo

### ProjectModel._apply 只能回滚顶层属性

`DataEditCommand` 通过 `ProjectModel._apply` 使用 `setattr(self, key, value)` 来恢复数据。这意味着 undo 只能回滚整个顶层属性（如把 `self.quests` 整体替换为旧值）。但编辑器中绝大多数变更都是嵌套 dict 内部的修改（改某个 quest 的 title、改某个 hotspot 的 x 坐标等），这些变更通过 `mark_dirty` 标脏但不经过 `push_edit`，因此无法通过 undo 回滚。Undo 系统在当前编辑器中实质上不可用。

### flush_to_model 不刷新画布

SceneEditor 的 `flush_to_model` 方法在 Save All 时被主窗口调用，将属性面板 widgets 的值写回 model dict。但它不更新画布上的图形元素——NPC 圆点位置、zone 多边形、巡逻路径等仍显示旧数据。用户保存后看到画布上 NPC 还在老位置，需要切换场景才能看到更新。这给用户造成"保存没生效"的错觉，也可能导致用户在画布上继续编辑时覆盖已保存的值。

### _pending_* 引用在场景重载后可能指向过期 dict

ScenePropertyPanel 的 `_pending_hotspot`、`_pending_npc`、`_pending_zone` 直接引用 `model.scenes` 中的 dict 对象。当用户点 Apply 后 `_load_scene` 重新加载场景，虽然 `_load_scene` 用的是同一个 scene dict（`self._model.scenes.get(scene_id)` 返回的是同一个引用），但如果场景列表被重新赋值（如 `_delete_group` 中 `self._model.quests = [...]` 模式），这些 `_pending_*` 引用会指向已经从模型中移除的旧 dict。后续 `flush_to_model` 会将变更写入已删除的数据。

## Ink 编辑器（已弃用 / 历史）

以下针对内置 Ink 文本编辑与高亮；**不参与**运行时。若编辑器已移除 Ink 页，可忽略或仅作归档。

### InkHighlighter 对多行条件块高亮不完整

`InkHighlighter._rebuild_rules` 中条件块的正则是 `^\{.*$`，只匹配以 `{` 开头的行。但 Ink 的多行条件块格式是首行为 `{ CONDITION:`，后续行为 `- condition:`，末行为 `}`。`^\s*-\s*else\s*:` 匹配了 `- else:` 行，但 `- condition:` 格式的行和中间的内容行不会被高亮为条件语法。

### InkHighlighter._rebuild_rules 的 knot 正则过于宽泛

匹配 knot 的正则是 `^===.*===$`，这会匹配任何以 `===` 开头且以 `===` 结尾的行。但 Ink 语法中 `=== knot_name ===` 和 `== DIVERT ==` 使用不同数量的等号。虽然实践中不会冲突，但正则没有区分 knot 声明和 section 分隔符。
