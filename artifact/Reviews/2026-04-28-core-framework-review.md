# 架构审查报告

**审查时间戳：** 2026-04-28 12:00

---

## 文档同步说明（已与 `GameDraft/游戏架构设计文档.md` 对照当前代码并以代码为准完成同步）

- **§二 架构原则 5**：将「FlagStore 为唯一条件源」精炼为：**flag key 仍以 FlagStore 为唯一数据源**；同时写明广义 `ConditionExpr` 可走 `QuestManager` / `ScenarioStateManager`，与运行时求值实现对齐。
- **§3.3 FlagStore**：增补 **Scenario** 相位、**任务**叶子与 `evaluateGraphCondition` / `conditionEvalBridge` 的一体化说明（替代仅强调「flag 委托」的旧表述）。
- **§3**：新增 **3.11 ScenarioStateManager**、**3.12 resolveText**。
- **§五 系统层**：插入 **5.4 DocumentRevealManager**；原定 **§5.4～5.14** 顺延为 **§5.5～5.15**（对话、任务、规矩…开发模式）。
- **§5.3 GraphDialogueManager**：写明构造注入 **SceneManager / RulesManager / QuestManager / InventoryManager / ScenarioStateManager**，并标明与「仅靠事件」铁律之间的**已知张力**。
- **§八 目录结构** 与 **public/assets/data**：补充 `ScenarioStateManager.ts`、`resolveText.ts`、`DocumentRevealManager`、`graphDialogue/conditionEvalBridge`、`utils/`、`scenario.json` 相关条目及 `document_reveals.json`、`overlay_images.json`、`flag_registry.json`、`questGroups.json` 等数据文件列举。

审查过程中**未改动** TypeScript 业务源代码，仅更新上述架构 Markdown。

---

## 问题列表（按审查问题类型逐项覆盖）

### 1. 耦合

- [ ] **位置：** `src/systems/GraphDialogueManager.ts`。**描述：** 除 EventBus / FlagStore 外，**长期持有** `SceneManager`、`RulesManager`、`QuestManager`、`InventoryManager`、`ScenarioStateManager` 引用，并在推进中直接调用（如 `sceneManager.getNpcById`、`rulesManager.getRuleDef`），并非仅通过 EventBus / FlagStore 交互。**违反原则：** 《架构》§二 铁律 2（理想形态下同级系统互不持有引用）。
- [ ] **位置：** `src/systems/DocumentRevealManager.ts`。**描述：** 直接依赖 `QuestManager` 与 `ScenarioStateManager` 构建 `ConditionEvalContext`。**违反原则：** 同上（同属「查询型耦合」）。
- [ ] **位置：** `src/core/ActionRegistry.ts`。**描述：** 静态集中注册对所有业务系统的 handler 依赖，语义上的**单一枢纽**，任何动作类型扩充都会汇集于此。**违反原则：** 铁律 2 精神层面——非事件式耦合向此处聚拢（通常为可接受权衡，但需有意识维护）。
- [ ] **位置：** `src/ui/MapUI.ts`。**描述：** UI 层直接 `import ../systems/graphDialogue/*` 与 `FlagStore`，并持有 `ConditionEvalContext` 工厂，与 §6.1「以只读数据接口 + EventBus」的叙事存在偏差。**违反原则：** §6.1 UI 边界与铁律 2（UI ↔ 系统在条件求值上与系统层模块交叉）。

### 2. 过度设计

- [ ] **位置：** `IGameSystem` 与若干空的 `init`/`update`。 **描述：** 部分系统为满足统一接口而存在空生命周期方法；在体量可控时为合理统一，但若继续膨胀可考虑按角色拆分接口。**违反原则：** 轻微冗余，非硬性铁律违反。
- [ ] **位置：** `ConditionEvalContext` 工厂在多模块（Quest、Encounter、Interaction、Archive、Inventory、Zone、Game → MapUI 等）**重复注入模式**。**描述：** 为共享求值语义而分散工厂注册，属可维护性好坏参半的重复。**违反原则：** 「重复能力」维度的低风险技术债。

### 3. 分层违反

- [ ] **位置：** `src/core/SceneDepthSystem.ts`。**描述：** Core 直接依赖 `pixi.js` `Texture` 与 `rendering/DepthOcclusionFilter`。**违反原则：** 《架构》§二 铁律 1（下层原则上不依赖「渲染封装」）。
- [ ] **位置：** `src/systems/SceneManager.ts`。**描述：** 系统层深度直接使用 Pixi API 与 `Renderer` 装配场景。**违反原则：** 「系统经由渲染封装操纵表现」的理想边界与实际实现的张力。
- [ ] **位置：** `src/systems/EmoteBubbleManager.ts`。**描述：** 系统层模块内创建 `Container` / `Graphics` / `Text`。**违反原则：** 与 §5.11/`CutsceneRenderer`「演出/表现尽量委托渲染层」的表述存在张力。
- [ ] **位置：** `src/core/Game.ts` 主循环（如深度遮挡相关对 `renderer.entityLayer.children` 的遍历）。**描述：** Core 游戏循环了解渲染层子树结构。**违反原则：** 铁律 1（Core 对 Rendering 内部结构可见）。

### 4. 生命周期与销毁

- [ ] **位置：** `src/systems/DialogueManager.ts` 的 `destroy()`。**描述：** 未在销毁路径上调用 `endDialogue()`，若销毁发生在脚本台词进行中，可能不发出 `dialogue:end`，与仍订阅 UI 状态短暂不一致。**违反原则：** §二 铁律 8（销毁后无残留、行为一致）。
- [ ] **位置：** `src/core/Game.ts` `destroy()` 中 `eventBus.clear()` 与各 `system.destroy()` 的次序。**描述：** 先清空总线再销毁系统，依赖各系统 `destroy` **不**再依赖 `emit`；当前成立，但隐式约定脆弱。**违反原则：** 铁律 8（顺序敏感的全局约定）。

### 5. 数据驱动与配置驱动

- [ ] **位置：** 业务代码抽查（如 `Game.ts` 开发模式中的 `dev_room`）。**描述：** 开发模式枢纽场景 ID 在代码中固定，属**结构性/工具链**硬编码，与 §九「允许硬编码」一致。**违反原则：** 无明显配置驱动违规；持续注意勿将可内容化 ID 写入逻辑。

### 6. 统一动作执行

- [ ] **位置：** 遭遇结果、区域 `onEnter`/`onStay`/`onExit`、任务 `acceptActions`/`rewards`、延迟事件、`executeForDialogue` 等路径抽样。**描述：** 状态变更型行为主要经 `ActionExecutor` 的 `executeAwait` / `executeBatchAwait` / `executeForDialogue` 等入口。**违反原则：** 未发现系统性绕过铁律 6 的路径（零散的 `QuestManager.acceptQuest` 等由 Action handler 显式调用，属设计内路径）。

### 7. 接口与约定

- [ ] **位置：** `EmoteBubbleManager` 与 `IEmoteBubbleProvider`（若仍存在仅结构类型兼容）。**描述：** 若类声明未显式 `implements` 注入接口，可读性略弱。**违反原则：** 铁律 7（显式接口约定）。

### 8. 其他

- [ ] **位置：** `window.__gameDevAPI`（`Game.ts`）。**描述：** 开发模式全局入口，属刻意暴露；非生产玩家路径需注意污染与文档同步。**违反原则：** 铁律 8 / 全局单例类风险（已文档化于 §5.15）。
- [ ] **位置：** `src/core/InteractionCoordinator.ts`、`EventBridge.ts` 等。**描述：** 位于 `core/` 但依赖 `systems/*`；与仅 `Game` 作为组装例外的读者预期可能不一致——建议读者将「与 `Game` 同级的编排模块」一并理解为组装层。**违反原则：** 文档精确性（已在历史审查中记录，仍适用）。

---

## 下一步

当前仅完成**审查**、**架构设计文档同步**与**本报告归档**，**未修改** `src/` 下 TypeScript 业务实现。

如需按项做代码层修复，请回复 **「开始修复」**。

报告路径：`GameDraft/artifact/Reviews/2026-04-28-core-framework-review.md`
