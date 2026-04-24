---
name: add-text-ref
description: >-
  在 GameDraft 中扩展项目级文本引用 [tag:…]：新增 resolveText 类型、玩家可见展示点、或编辑器 RichTextField 挂载。
  触发词：add tag、新引用、ref、引用类型、resolveText、TagCatalog、嵌入引用、RichTextField、ref_validator。
---

# 文本引用系统扩展清单

所有玩家可见字符串经同一 `resolveText(raw, ctx)`；编辑器侧须 **TagCatalog + RichTextField + ref_validator 白名单** 三件套一致，缺一视为未完成。

## 1. 添加新 ref 类型（kind）

1. **运行时** `GameDraft/src/core/resolveText.ts`：为新 kind 增加解析分支；未知 kind 保持原样并 `console.warn`。
2. **上下文** `ResolveCtx` / `Game.ts` 的 `buildResolveContext`（或等价工厂）：注入数据源（静态表、Manager、Map 缓存等）。
3. **StringsProvider**：保持「先 `{var}` 插值，再 resolve」；`string` 类 ref 注意防递归标志位。
4. **编辑器** `tools/editor/shared/tag_catalog.py`：`list_by_kind` / `marker_for` / `validate_exists` 各增分支。
5. **插入 UI** `tools/editor/shared/rich_text_field.py`：`_KIND_LABELS` 与 `InsertRefDialog` 列表页同步。
6. **校验** `tools/editor/shared/ref_validator.py`：`_TAG_PATTERNS` 增正则；`scan_refs` 已与 `TagCatalog.validate_exists` 联动。
7. **本 SKILL**：在下面「样例」补一条新 kind 的端到端说明。

## 2. 添加新展示位置（运行时包 resolveText）

1. 定位「原始 string 从数据层流出、进入 UI 之前」的唯一边界（不要在 load 时改写存档 raw）。
2. 在该处调用 `game.resolveDisplayText(raw)` 或等价 `resolveText(raw, game.getResolveCtx())`。
3. 若当前仅在 **纯渲染 UI** 内拿到字符串，应上移到派发/Manager 层包一层，避免多处重复解析。
4. **白名单**：在 `tools/copy_manager/constants.py` 的 `JSON_EXTRACTION_RULES` / `NESTED_EXTRACTION_RULES`（及 ref_validator 若单独枚举处）登记字段路径，确保 **save 前校验** 与 **copy_manager 扫描** 能覆盖。

## 3. 添加新编辑挂载点（RichTextField）

1. 将策划可写玩家可见文案的 `QLineEdit` / `QTextEdit` 换为 `RichTextLineEdit(model)` / `RichTextTextEdit(model)`（`tools/editor/shared/rich_text_field.py`）。
2. 读写 API：`text()`/`setText()`、`toPlainText()`/`setPlainText()`、`textChanged` 与原生一致，便于替换。
3. **图编辑器** `tools/graph_editor/panels/*`：面板需 `ProjectModel` 时，实现 `set_editor_model(pm)`；由 `property_stack.PropertyStack.set_project_path` 统一 `_load_pm` 后 `_distribute_editor_model`。

## 4. 反例（禁止）

- 手打 `[tag:…]` 而不经插入对话框（策划流程）。
- 绕过 `RichTextField` 在 JSON 里直接写 ref 却无校验覆盖。
- 在数据 load 时解析并写回内存结构（应用 **JIT**，存档永远存 raw）。
- 为单个 UI 单独写一套解析函数而不走 `resolveText`。

## 5. 现有样板

- **运行时批量解析**：`ArchiveManager` 等与 `resolveLine` / `setResolveForDisplay` 的组合（原 `expandGameTags` 已迁入 `resolveText`）。
- **档案编辑器**：`archive_editor` 中「插入 tag」按钮 → `InsertRefDialog`；正文区配合 `RichTextTextEdit` 与「插入图片」对 `core_text_edit()` 取 `QTextCursor`。

## 6. 校验与保存

- `ProjectModel.save_all` 调用 `validate_refs_for_save`；失败应 `raise ValueError` 阻断保存。
- 主编辑器「Validate Data」走 `validator.validate`，其中已合并 `validate_all_embedded_refs` 结果。
