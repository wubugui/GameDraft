# 架构审查报告

**审查时间戳：** 2026-03-22 21:00

## 文档同步说明

- 补充遭遇 UI→系统方向的三个事件至事件清单：`encounter:narrativeDone`、`encounter:choiceSelected`、`encounter:resultDone`。
- 移除文档中 `ruleUse:showResult` 事件（代码中无任何发布/订阅）。
- 补充 NPC 动画配置文件 `npc_*_anim.json` 到数据目录结构。
- 其余内容（目录结构含 4 个新 core 模块、ActionExecutor 动作表、系统列表、UI 面板表、Game 模块拆分描述）与代码一致，无需额外同步。

## 问题列表

### 1. 耦合

- [x] **位置**：`src/ui/BookshelfUI.ts`。**已修复**：移除对 CharacterBookUI、LoreBookUI、DocumentBoxUI 的直接 import，改为通过 `OnOpenSubPanel` 回调注入，由 Game 组装层负责创建子面板实例。

### 2. 过度设计

- 未发现。IGameSystem 已全面落地，无多余抽象层或仅单实现的扩展点。

### 3. 分层违反

- [x] **位置**：`src/ui/DialogueUI.ts`、`src/ui/DialogueLogUI.ts`、`src/ui/EncounterUI.ts`。**已修复**：将 `DialogueLine`、`DialogueChoice`、`ResolvedOption` 接口从 Systems 层（DialogueManager、EncounterManager）移至 `src/data/types.ts`，UI 和 Systems 均从 data 层导入。

### 4. 生命周期与销毁

- [x] **位置**：`src/ui/BookshelfUI.ts`、`src/ui/CharacterBookUI.ts`、`src/ui/LoreBookUI.ts`、`src/ui/DocumentBoxUI.ts`。**已修复**：四个组件均已补充 `destroy()` 方法，调用 `close()` 确保容器和渲染对象被清理。

### 5. 数据驱动与配置驱动

- [x] **位置**：绝大多数 UI 组件。**已修复**：将 16 个 UI 组件的所有玩家可见中文文案迁移到 `strings.json`，各组件通过注入的 `StringsProvider` 读取。涉及组件：BookshelfUI、BookReaderUI、CharacterBookUI、LoreBookUI、DocumentBoxUI、HUD、InspectBox、InventoryUI、MapUI、PickupNotification、QuestPanelUI、RulesPanelUI、RuleUseUI、ShopUI、DialogueLogUI、DialogueUI、EncounterUI、MenuUI。DebugPanelUI 保留硬编码（仅调试用，非玩家可见）。
- [x] **位置**：`src/core/Game.ts`。**已修复**：`tryStartInitialPrologue()` 改为从 `gameConfig.initialCutsceneDoneFlag` 读取防重复标记 key，`game_config.json` 中配置 `"initialCutsceneDoneFlag": "prologue_started"`，代码不再硬编码该值。

### 6. 统一动作执行

- [x] **位置**：`src/core/EventBridge.ts`。**已修复**：`ruleUse:apply` 中的 `flagStore.set()` 改为 `actionExecutor.execute({ type: 'setFlag', ... })`，通过统一动作执行路径设置标记。EventBridge 不再直接依赖 FlagStore。

### 7. 接口与约定

- [x] 与第 3 条同源，已一并修复。`DialogueLine`、`DialogueChoice`、`ResolvedOption` 现定义在 `src/data/types.ts`。

### 8. 其他

- 未发现循环依赖、全局单例滥用或职责混杂问题。
- 未发现事件命名与文档不一致的问题（文档已同步）。
- `EmoteBubbleManager` 不实现 IGameSystem，作为辅助模块由 CutsceneManager 使用，已在文档 5.9.1 中说明，属于合理设计。

## 修复完成

所有 7 项问题均已修复。`tsc --noEmit` + `npm run build` 全部通过。
