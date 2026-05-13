# 架构审查报告

**审查时间戳：** 2026-03-22 15:00

## 文档同步说明

- 架构设计文档与当前代码一致：目录结构、系统列表、UI 面板、ActionExecutor 动作类型（含 shopPurchase、inventoryDiscard）、EmoteBubbleManager、DebugPanelUI 均已同步。
- `docs/rendering-architecture.md` 为渲染层补充文档，主架构文档未引用，建议在「四、渲染层」下增加「详见 docs/rendering-architecture.md」的交叉引用（可选）。
- 演出 JSON 中使用 `set_flag`，CutsceneManager 映射为 `setFlag`，与 ActionExecutor 约定一致。

## 问题列表

### 1. 耦合

- [x] **位置**：`src/core/Game.ts`。**已修复**：将 ActionHandler 注册、交互分发、事件桥接、调试工具提取为 `ActionRegistry`、`InteractionCoordinator`、`EventBridge`、`DebugTools` 四个独立模块，Game 缩减为薄组装层。
- [x] **位置**：`src/ui/BookshelfUI.ts`。**已修复**：移除 `setBookReaderUI`，改为在构造时注入 `onOpenBook` 回调，由 Game 传入打开 BookReaderUI 的逻辑；BookshelfUI 不再持有 BookReaderUI 引用。

### 2. 过度设计

- 未发现明显过度设计。`IGameSystem` 已全面落地，`ActionExecutor` 无重复 handler，系统间无多余抽象。

### 3. 分层违反

- 无新发现。架构文档已补充 Game 作为引导/组装层的例外约定。

### 4. 生命周期与销毁

- 无新发现。`main.ts` 已注册 beforeunload/pagehide 调用 `game.destroy()`；`Game.destroy()` 已调用各 UI 与 `emoteBubbleManager.destroy()`；`GameStateController.destroy()` 已关闭并销毁 panel。

### 5. 数据驱动与配置驱动

- 无新发现。商店、菜单文案已走 strings.json；开场演出已由 `game_config.initialCutscene` 配置驱动。
- [ ] **位置**：`src/core/Game.ts`。`tryStartInitialPrologue()` 使用 `prologue_started` 作为防重复标记，该 key 与业务 ID 强绑定，若更换 `initialCutscene` 或增加多段开场，需同步调整。建议：可改为 `initialCutscene_played` 或由配置定义防重复 key，当前为可接受的数据驱动边界。

### 6. 统一动作执行

- 无新发现。商店购买、背包丢弃已通过 ActionExecutor；档案标记已由 ArchiveManager 内部同步 FlagStore。
- [ ] **位置**：`src/core/Game.ts`。`ruleUse:apply` 监听中，Game 在 `executeBatch` 后直接执行 `flagStore.set(\`rule_used_${payload.ruleId}\`, true)`。按「各系统同步写入 FlagStore」原则，`rule_used_*` 标记 ideally 应由 ZoneSystem 或规则使用相关系统维护。当前由 Game 桥接设置，属于灰色地带，可后续考虑迁移到系统层或通过 resultActions 中的 setFlag 动作显式写入。

### 7. 接口与约定

- 各系统均已实现 `IGameSystem`，`init`/`update`/`serialize`/`deserialize`/`destroy` 由 Game 与 SaveManager 统一调度，符合约定。
- `dialogue:start` payload 为 `npcName`，与文档一致。

### 8. 其他

- [x] **位置**：`src/core/Game.ts`。**已修复**：Game.ts 从 ~998 行缩减至 ~490 行，动作注册、热点/NPC 交互分发、事件桥接（对话/遭遇/菜单/商店/地图/规矩使用）、调试工具分别提取到 `ActionRegistry.ts`、`InteractionCoordinator.ts`、`EventBridge.ts`、`DebugTools.ts`，Game 仅保留组装、场景回调、玩家初始化、主循环和存档逻辑。
- 未发现循环依赖、全局单例滥用或事件命名与文档明显不一致的问题。

## 下一步

当前仅完成审查与报告，未修改代码。如需修复，请回复「开始修复」。
