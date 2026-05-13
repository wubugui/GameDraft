# 架构审查报告

**审查时间戳：** 2026-04-11 14:30

> **后注（2026-04）**：下文若仍提及 `bindInkExternals`、`inkExternals` 或 Ink 运行时，均为该次审查快照；当前对话由 **图对话 JSON** 驱动。

## 文档同步说明已与 `游戏架构设计文档.md` 对照当前代码完成同步（以代码为准），主要包括：

- **§3.0 `GameContext`**：补充 `AssetManager` 字段。
- **§3.9 `SceneDepthSystem`**：更正为实现 `IGameSystem`，纳入 `registeredSystems` 与存档序列化；删除「非 IGameSystem」表述。
- **§5.9.1 `EmoteBubbleManager`**：更正为同时作为 `IGameSystem` 注册，并对外提供与 `IEmoteBubbleProvider` 一致的能力；保留 `setEmoteBubbleProvider` 注入方式说明。
- **§3.2 事件清单**：`day:end` / `day:start` 补充 `payload: { dayNumber }`。
- **§3.10 动作表**：补充 `enableRuleOffers`、`disableRuleOffers`、`setPlayerAvatar`、`resetPlayerAvatar`、`setSceneDepthFloorOffset`、`resetSceneDepthFloorOffset`；修正 `updateQuest` 行文案以匹配 `acceptQuest` 实现。
- **§5.13 开发模式**：`DevModeUI` 描述与 **Scene** 分类、`window.__gameDevAPI.openDevPanel` 与代码一致。
- **§八 目录结构**：`core/` 增加 `RuleOfferRegistry.ts`；`ui/` 与 **§6.2** 增加 `DevModeUI`。

**未修改任何游戏业务代码**（仅架构文档上述同步）。

---

## 问题列表

### 1. 耦合

- [ ] **位置：** `src/systems/DialogueManager.ts`（构造与 `bindInkExternals`）、`src/data/inkExternals.ts`。**描述：** 对话系统构造函数持有 `InventoryManager` 引用，Ink 外部函数 `getCoins` 直接读背包系统。**违反原则：** 《架构》§二铁律 2（同层系统不互持引用；通信应主要通过 EventBus / FlagStore）。
- [ ] **位置：** `src/ui/` 下 `QuestPanelUI`、`RulesPanelUI`、`BookReaderUI`、`BookshelfUI`、`InventoryUI`、`ShopUI`、`RuleUseUI`、`MapUI` 等。**描述：** 多块 UI 直接依赖具体 Manager / `ZoneSystem` / `FlagStore`，而非文档 §6.1 所强调的「以只读数据接口为主 + 事件桥」的收敛形态。**违反原则：** §6.1 与铁律 2（UI 与业务系统耦合面偏大）。
- [ ] **位置：** `src/core/ActionRegistry.ts`。**描述：** 单文件集中注册所有动作 handler，编译期依赖几乎所有业务系统类型，是刻意的枢纽，与「系统间仅通过事件与标记解耦」的字面表述存在张力（属设计取舍，但耦合向此处聚集）。**违反原则：** 铁律 2（精神层面：变更一处动作常牵动整表依赖）。

### 2. 过度设计

- [ ] **位置：** `src/data/types.ts` 中 `IGameSystem` 与若干系统实现。**描述：** 多类系统的 `init` / `update` 为空实现，仅为满足统一接口；在规模可控前提下可接受，但接口「一刀切」带来少量名义负担。**违反原则：** 非严重违反；若追求极简可讨论按角色拆分子接口（当前记为轻微冗余）。
- [ ] **位置：** `src/core/EventBus.ts`。**描述：** 事件名为原始字符串，与文档事件清单无编译期绑定，易出现命名漂移或遗漏文档更新。**违反原则：** 维护性风险（非铁律硬性违反，属机制重复风险中的「弱约束」）。

### 3. 分层违反

- [ ] **位置：** `src/core/SceneDepthSystem.ts`。**描述：** 置于 Core 包内，但依赖 `pixi.js` 的 `Texture` 与 `rendering/DepthOcclusionFilter`，形成 **Core → Rendering** 的依赖方向，与《架构》§二分层图「Rendering 在 Core 之上」及铁律 1（下层不依赖上层）冲突。**违反原则：** 铁律 1。
- [ ] **位置：** `src/systems/EmoteBubbleManager.ts`。**描述：** 系统层模块直接创建 Pixi显示对象（`Container` / `Graphics` / `Text`），与 §5.9 中 Cutscene 渲染尽量委托 `CutsceneRenderer` 的分层意图不一致。**违反原则：** §5.9 精神、铁律中「系统层不直接操作底层渲染」的严格解读。
- [ ] **位置：** `src/systems/SceneManager.ts`。**描述：** 系统层深度使用 Pixi 与 `Renderer` 拼装场景图元；若采用最严格分层，应更多下沉到渲染封装层。**违反原则：** 与「系统通过渲染封装操作场景」的理想边界存在张力（可与 EmoteBubble 合并理解为「系统层含重度渲染职责」的既定现实）。

### 4. 生命周期与销毁

- [ ] **位置：** `src/systems/DialogueManager.ts` 的 `destroy()`。**描述：** 仅清空 `story` 与 `active` 等字段，若销毁发生在对话进行中，不调用 `endDialogue()`，也不发出 `dialogue:end`，可能与仍打开的 UI 状态短暂不一致。**违反原则：** §二铁律 8（销毁后行为与资源一致性）。
- [ ] **位置：** `src/core/Game.ts` 的 `destroy()`。**描述：** 在调用各 `system.destroy()` 之前执行 `eventBus.clear()`，全局清空监听；依赖各系统 `destroy` 仅清理本地资源、不依赖再 `emit`。当前顺序可工作，但若未来某系统销毁逻辑依赖总线通知，会失效。**违反原则：** 铁律 8（隐式约定较强，顺序脆弱性）。

### 5. 数据驱动与配置驱动

- [ ] **位置：** `src/core/Game.ts` 中 `placeholderPlayerAvatar()` 等。**描述：** 占位玩家动画的帧范围、帧率等为代码内常量，属文档 §九「允许硬编码」中的结构性默认值范畴；**未发现**明显业务 ID / 文案级硬编码违规。**违反原则：** 无实质违反（持续注意新增逻辑勿写入具体任务名、NPC 名等）。

### 6. 统一动作执行

- [ ] **位置：** 遭遇、区域、对话标签、任务奖励、延迟事件、`CutsceneManager` 中 `execute_action` 等路径抽样。**描述：** 结果类行为均进入 `ActionExecutor.execute` / `executeBatch`（含 Zone 上下文变体）；Ink 侧仅只读外部函数，未绕过执行器写状态。**违反原则：** 未发现明显违反铁律 6 的路径。

### 7. 接口与约定

- [ ] **位置：** `src/systems/EmoteBubbleManager.ts` 与 `src/data/types.ts` 中 `IEmoteBubbleProvider`。**描述：** 类声明仅写 `implements IGameSystem`，未显式 `implements IEmoteBubbleProvider`，依赖 TypeScript 结构类型兼容注入 `CutsceneManager`。**违反原则：** §二铁律 7（接口约定可读性 / 显式性略弱）。
- [ ] **位置：** 文档原 §3.9 / §5.9.1 与代码不一致处。**描述：** 已通过本次文档同步对齐（见上文「文档同步说明」）。**违反原则：** （已消除历史不一致）

### 8. 其他

- [ ] **位置：** `src/core/InteractionCoordinator.ts`、`src/core/EventBridge.ts`、`src/core/DebugTools.ts`、`src/core/ActionRegistry.ts`。**描述：** 这些模块位于 `core/` 但静态依赖 `systems/*`，铁律 1 正文仅明确 **`Game` 组装例外**，未写明上述模块是否同等适用；读者易误判为「Core 依赖 Systems」违反分层。**违反原则：** 文档精确性 / 铁律 1 例外范围待澄清（建议在架构文档中单列「与 Game 同属组装/编排的 Core 模块」）。
- [ ] **位置：** `src/core/Game.ts` 主循环 `tick()`。**描述：** 为深度遮挡遍历 `renderer.entityLayer.children` 并识别滤镜类型，游戏循环与渲染层内部子树结构耦合。**违反原则：** 铁律 1（Core 对 Rendering 内部结构的感知）。

---

## 下一步

当前仅完成审查、架构文档同步与报告归档，**未修改** `src/` 等业务实现代码。如需按项修复架构问题，请回复 **「开始修复」**。

报告路径：`artifact/Reviews/2026-04-11-1430-core-framework-review.md`
