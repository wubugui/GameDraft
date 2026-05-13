---
name: editor-tools-iteration
description: Guides safe, pattern-based iteration on GameDraft PySide editor tools (tools/editor, graph_editor, scene_depth_editor, etc.). Use when the user asks to 迭代编辑器,改编辑器, 改策划工具, Action编辑器, 表单, PySide, Qt 编辑器, or any change under tools/editor or related desktop editors. Emphasizes data integrity, selector-based fields, sensible list/button/input layouts (reorder, context menu, no overstretched widgets), grouped UI with collapsible sections default-collapsed, and post-change save/regression review.
---

# GameDraft 编辑器工具迭代

在修改 `GameDraft/tools/editor`、`tools/graph_editor`、`tools/scene_depth_editor` 等基于 PySide 的编辑器时，**必须先读本技能再改代码**。

## 1. 数据正确性（最高优先级）

- 明确数据的**单一来源**：内存模型（如 `ProjectModel`）、JSON 路径、`Apply`/`flush_to_model`/`save_all` 的调用链；改 UI 必须同步到与现有保存路径一致的字段。
- 加载/重载时使用 `blockSignals`、`_loading_ui` 等既有模式，避免初始化阶段触发写回覆盖用户输入。
- 新增字段时：校验器（`validator.py`）是否需要同步；若跳过校验，说明风险并尽量补规则。
- **禁止**静默丢弃列表顺序、dict 键顺序、或「未显示在表单里」的键，除非需求明确要求且已文档化。

## 2. 输入方式：默认禁止纯手打

- **凡是可以枚举、引用、映射、约束的值**，都**必须优先使用选择器/下拉/对话框/专用控件**，禁止让用户纯手打字符串；包括但不限于 **ID、flag、scenario、quest、资源引用、枚举类型**等。
- 优先复用工程内已有组件（如 `IdRefSelector`、`FlagKeyPickField`、`FlagPickerDialog`、下拉、`pick_strings_multi` 等）；若现有组件不合适，新增控件也应遵循**只选清单/受控输入**模式。
- `QLineEdit` 仅保留给**确属自由文案且无法选择器化**的字段（描述、台词、JSON 专家模式等）；若字段看似文本但实际受已有清单约束，不得偷懒用自由输入代替。
- 若清单来自模型，在 `reload` / 切换行时刷新候选项，避免 Apply 前选项过期。
- 与运行时/校验器约定的枚举，必须与 TS/Python 侧白名单一致，禁止靠用户拼写。

## 3. 界面与交互

- **分区**：按数据域分组（`QGroupBox`、拆分 Tab、`QSplitter`），避免长表单无结构堆叠。
- **折叠**：复杂块用折叠（如 `QToolButton` + `QWidget` 可见性）；**默认折叠**；展开状态勿默认占满首屏。
- **尺寸**：预估单行/多行内容高度；表格设合理 `minimumHeight`；多行说明用 `QTextEdit` 或自适应高度策略，避免一行的字被裁切。
- **文案**：GUI 上**不要堆大段说明文字**；说明、规则、注意事项默认优先进 `setToolTip` 或悬浮提示；占位符保持简短，只提示输入意图，不写成长说明。
- **复杂界面**：先检索是否已有可复用面板/对话框/共享模块；若界面复杂度高，再优先检查是否已有合适的现成插件/成熟组件，避免重复造轮子。
- **列表**：实现可编辑列表时，**按需**补齐或评估：**上移/下移**（顺序写入 JSON/模型时必须支持）、**删除**、多选与 **Delete 快捷键**（若已有同类列表则对齐）；**右键上下文菜单**（删除/移动/复制等）在条目多、操作多时优先考虑；行为须与数据顺序、校验器一致。
- **输入框布局与大小**：按字段语义控制宽高；短 ID、枚举、数字框**不要**无脑 `stretch` 或超大 `minimumWidth` 拉成满行；长文本、路径再占宽行或独占一行；`QFormLayout`/`QSizePolicy` 配合使用，避免所有输入控件同一宽度模板。
- **按钮**：**短标签**（可配图标或「添加」「删除」等），细则用 `setToolTip`；**禁止**一排超长全文按钮或纵向无限堆长句按钮；用 `QHBoxLayout` + `addStretch()`、分组框内工具行、`QDialogButtonBox` 等常规排布；主/次操作位置分明，不为了省事整行铺满。

## 4. 实现方式与架构

- 先判断本页是**何种编辑模式**（主从列表+详情、单表、内嵌 JSON 树、动作列表等），再对齐项目中**已有同类编辑器**的结构，而不是临时堆控件。
- **禁止临时方法、能用就行**：先判断编辑模式、数据流和交互模式，再用项目中常见的模式/架构实现；避免把一次性逻辑散落在槽函数里、靠条件分支硬拼出 UI。
- **PySide**：优先常规信号槽、`QFormLayout`、`QComboBox`/`QListWidget` 标准行为；避免依赖未文档化的内部对象、全局 hack、或与 Qt 版本强绑定的「技巧」。
- **瞻前顾后**：搜索引用该面板/模型字段的其他编辑器；共用 `ProjectModel` 的改动要考虑场景编辑器、任务编辑器等是否受影响。

## 5. 完成后的自检（必须逐条过一遍）

1. **逻辑与需求**：是否自洽、是否覆盖边界（空列表、未选行、重复 id、孤儿引用、未 Apply 的缓冲等）。
2. **横向影响**：本次改动是否破坏其他编辑器或同一文件的其它流程。
3. **数据保存（重中之重）**：从 UI 修改到 `mark_dirty` / 写盘的路径是否完整；是否会在错误时机 `sync` 清空字段；是否保持与磁盘 schema 兼容。

## 6. 与仓库其他技能的关系

- 若迭代**仅 JSON 数据、不动代码**：优先遵循 `pure-data-iteration`。
- 若涉及**玩法向数据**：还需对照 `gameplay-iteration` 与玩法文档。
- 本技能聚焦**桌面编辑器工具**的代码与 UX；不替代架构文档，但不得与架构文档冲突。
