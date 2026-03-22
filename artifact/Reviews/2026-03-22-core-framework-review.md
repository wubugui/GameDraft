# 架构审查报告

**审查时间戳：** 2026-03-22

## 文档同步说明

- 在系统层 5.9 下补充 `EmoteBubbleManager`（辅助模块，非 IGameSystem）
- 在 UI 面板清单中补充 `DebugPanelUI`（F2/反引号触发）
- 在 ActionExecutor 动作类型表中补充：`showEmote`、`pickup`、`switchScene`、`changeScene`
- 在目录结构中补充 `EmoteBubbleManager.ts`、`DebugPanelUI.ts`

## 问题列表

### 1. 耦合

- [ ] **位置**：`src/core/Game.ts`。`Game` 直接持有并编排几乎所有系统、渲染和 UI，对热点、对话、遭遇、商店、菜单、演出等集中调度，主入口承担了跨层总控职责。违反原则：**核心层职责清晰**（主入口可编排，但当前职责过重）。
- [x] **位置**：`src/ui/BookshelfUI.ts`。**已修复**：移除 `setBookReaderUI`，改为构造时注入 `onOpenBook` 回调，由 Game 传入打开逻辑，BookshelfUI 不再持有 BookReaderUI 引用。

### 2. 过度设计

- 未发现明显过度设计。`IGameSystem` 已全面落地，`ActionExecutor` 无重复 handler，`EncounterManager` 与 `RulesManager` 的耦合已消除。

### 3. 分层违反

- [x] **位置**：`src/core/Game.ts`。**已修复**：在架构文档中补充「引导/组装层」例外约定，明确 Game 作为 bootstrap 跨层创建实例属于允许的组装职责。

### 4. 生命周期与销毁

- [x] **位置**：`src/main.ts`。**已修复**：注册 `beforeunload` 和 `pagehide` 监听，在页面关闭时调用 `game.destroy()`。
- [x] **位置**：`src/core/Game.ts`。**已修复**：`destroy()` 中先 `closeAllPanels()`，再依次调用 `inspectBox`、`pickupNotification`、`dialogueUI`、`encounterUI`、`hud`、`notificationUI`、`bookReaderUI`、`emoteBubbleManager` 的 `destroy()`。
- [x] **位置**：`src/core/Game.ts`。**已修复**：同上，`emoteBubbleManager.destroy()` 已纳入 destroy 流程。
- [x] **位置**：`src/core/GameStateController.ts`。**已修复**：`destroy()` 中先 `closeAllPanels()`，再遍历 panels 调用有 `destroy` 方法的 panel，最后 `clear()`。

### 5. 数据驱动与配置驱动

- [x] **位置**：`src/core/Game.ts`。**已修复**：`shop:purchase` 相关文案改为使用 `stringsProvider.get('notifications', 'currencyInsufficient')` 与 `shopPurchased`。
- [x] **位置**：`src/ui/MenuUI.ts`。**已修复**：MenuUI 增加 `StringsProvider` 依赖，主菜单、暂停、存档/读档、设置等文案均从 `strings.json` 的 `menu` 分类读取。
- [x] **位置**：`src/core/Game.ts`。**已修复**：`tryStartInitialPrologue()` 改为从 `gameConfig.initialCutscene` 读取演出 ID；`game_config.json` 增加 `initialCutscene` 字段。

### 6. 统一动作执行

- [x] **位置**：`src/core/Game.ts`。**已修复**：新增 `shopPurchase`、`inventoryDiscard` 动作类型；`shop:purchase` 与 `inventory:discard` 事件处理改为通过 `ActionExecutor.execute()` 执行。
- [x] **位置**：`src/core/Game.ts`。**已修复**：档案标记同步移至 `ArchiveManager.addEntry` 内部，由该系统在写入时调用 `flagStore.set`；移除 Game 对 `archive:updated` 的 FlagStore 同步监听。

### 7. 接口与约定

- 各系统均已实现 `IGameSystem`，`init`/`update`/`serialize`/`deserialize`/`destroy` 由 `Game` 和 `SaveManager` 统一调度，符合约定。
- `dialogue:start` payload 文档已写明为 `npcName`，与实现一致。

### 8. 其他

- [ ] **位置**：`src/core/Game.ts`。`Game` 同时承担：装配、状态机、输入快捷键、热点分发、动作注册、存档分发、UI 面板注册、业务事件桥接、调试工具等，职责混杂。违反原则：**职责单一**。
- 未发现循环依赖、全局单例滥用或事件命名与文档明显不一致的问题。

## 下一步

当前仅完成审查与报告，未做任何代码修改。若需要修复，请回复「开始修复」。
