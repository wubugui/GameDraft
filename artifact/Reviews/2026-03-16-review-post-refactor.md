# 架构审查报告（重构后）

**审查时间戳：** 2026-03-16 18:30
**审查基准：** `游戏架构设计文档.md` 中的架构原则（铁律）与配置驱动清单
**审查范围：** `src/core/`、`src/systems/`、`src/ui/`、`src/rendering/`、`src/entities/`、`src/data/`
**对比基线：** 前次审查 `2026-03-16-1050-core-framework-review.md` 所列 8 类问题

---

## 前次问题修复确认

前次审查共列 8 类问题，本次逐条确认修复状态：

| 前次问题 | 修复状态 |
|---------|---------|
| 同层系统耦合（EncounterManager→RulesManager） | **已修复**，通过 FlagStore 查询替代直接引用 |
| 过度设计 | 前次无具体条目 |
| 分层违反 | 前次无具体条目 |
| 生命周期（匿名监听、缺 destroy） | **已修复**，Game.destroy() 完整、SceneManager/ArchiveManager/QuestManager 正确 off |
| 数据驱动（硬编码场景/任务 ID） | **已修复**，game_config.json + player_anim.json |
| 统一动作执行 | **已修复**，pickup/switchScene/CutsceneManager 指令走 ActionExecutor |
| IGameSystem 接口约定 | **已修复**，12 个系统全部 implements IGameSystem，注册表统一管理 |
| 职责混杂（Game.ts） | **已修复**，提取 GameStateController，UI 面板/快捷键/Escape 逻辑外移 |
| 孤立事件（archive:updated/rule:used/scene:ready） | **已修复**，添加了 FlagStore 消费者 |
| dialogue:start payload 语义 | **已修复**，npcId→npcName |
| ActionExecutor 重复 handler | **已修复** |
| UI 解耦 | **已修复**，引入 7 个只读数据接口 |

---

## 本次新发现问题列表

### 1. 耦合

- [ ] **[P1]** 位置：`src/systems/SceneManager.ts` 构造函数。SceneManager 直接接收 `InteractionSystem` 实例并调用其 `setHotspots()`、`setNpcs()`、`clearHotspots()`、`clearNpcs()` 方法。两者同属系统层，违反「同层系统不持有彼此引用」原则。可改为 SceneManager 通过事件发送热区/NPC 数据，由 Game.ts 或 InteractionSystem 自行监听。违反原则：**系统解耦**。

- [ ] **[P2]** 位置：`src/ui/RuleUseUI.ts`。构造函数接收 `ActionExecutor` 实例，在 `selectSlot()` 中直接调用 `actionExecutor.executeBatch(slot.slot.resultActions)` 执行游戏状态变更。UI 层不应直接驱动业务逻辑执行，应通过 EventBus 发出事件（如 `ruleUse:applySlot`），由 Game.ts 桥接到 ActionExecutor。违反原则：**分层依赖**、**统一动作执行**。

### 2. 过度设计

- 无显著问题。7 个 UI 数据提供接口（IQuestDataProvider 等）职责清晰、各有多处使用，属于合理抽象。

### 3. 分层违反

- [ ] **[P3]** 位置：`src/systems/CutsceneManager.ts`。作为系统层模块，直接创建 PixiJS 渲染对象（`Graphics`、`Text`、`Container`）并操作 `renderer.uiLayer`、`renderer.entityLayer`。系统层不应直接操作渲染细节，应通过渲染层封装的接口完成视觉表现。违反原则：**分层依赖**。

### 4. 生命周期与销毁

- [ ] **[P4]** 位置：`src/core/FlagStore.ts`。无 `destroy()` 方法。若游戏实例销毁后重建，FlagStore 内部 Map 残留旧数据。虽然 `deserialize()` 会 `clear()`，但缺少显式销毁语义不符合「完整生命周期」原则。违反原则：**完整生命周期**。

- [ ] **[P5]** 位置：`src/core/ActionExecutor.ts`。无 `destroy()` 方法，已注册的 handler 无法清理。若游戏重建，旧 handler 中的闭包可能引用已失效的系统实例。违反原则：**完整生命周期**。

- [ ] **[P6]** 位置：`src/core/Game.ts` `destroy()` 方法。销毁时逐条 `off` 自身注册的事件，但未调用 `eventBus.clear()`。若其他模块（UI 等）遗漏了 `off`，EventBus 中仍可能残留废弃的监听器。建议在所有系统销毁后调用 `eventBus.clear()` 作为兜底。违反原则：**完整生命周期**。

- [ ] **[P7]** 位置：`src/systems/DialogueManager.ts`、`src/systems/CutsceneManager.ts`。两者的 `serialize()` 返回空对象，`deserialize()` 为空实现。若玩家在对话/演出进行中存档再读档，对话/演出状态丢失，游戏可能卡在无法退出的状态。违反原则：**接口约定**（serialize/deserialize 应保证状态可恢复）。

### 5. 数据驱动与配置驱动

- [ ] **[P8]** 位置：系统层多处硬编码中文通知文案。
  - `RulesManager`：`'规矩本新增：${name}'`、`'获得规矩碎片'`、`'碎片合成：${name}'`
  - `InventoryManager`：`'包袱满了！'`
  - `QuestManager`：`'新任务：${title}'`、`'任务完成：${title}'`
  - `ArchiveManager`：`'档案更新'`
  - `EncounterManager`：`'未知规矩'`、`'碎片不足 ${collected}/${total}'`、`'道具不足'`

  这些文案属于面向玩家的文本，理论上应由本地化/配置系统管理。当前阶段可标记为低优先级技术债务。违反原则：**数据驱动**（轻度）。

- [ ] **[P9]** 位置：`src/ui/RulesPanelUI.ts` 第 10-14 行。规矩分类名 `CATEGORY_NAMES`（避祸/禁忌/行话/江湖）和验证状态标签 `VERIFIED_LABELS`（未验证/有效/存疑）硬编码在 UI 文件中。分类名是游戏内容定义的一部分，应随 `rules.json` 提供或由数据层管理。违反原则：**数据驱动**。

- [ ] **[P10]** 位置：`src/ui/LoreBookUI.ts` 第 103-108 行。见闻分类名 `categoryLabel()`（传说/地理/民俗/时事）硬编码。同理应由数据层定义。违反原则：**数据驱动**。

### 6. 统一动作执行

- [ ] **[P11]** 位置：`src/ui/RuleUseUI.ts` 第 159 行。`actionExecutor.executeBatch(slot.slot.resultActions)` 直接在 UI 层执行动作。违反统一动作执行的分层路径（UI→事件→Game→ActionExecutor）。应改为发出事件，由 Game.ts 中介执行。违反原则：**统一动作执行**（同 P2）。

### 7. 接口与约定

- [ ] **[P12]** 位置：`src/systems/DialogueManager.ts`、`src/systems/CutsceneManager.ts`。serialize/deserialize 为空实现，不满足 IGameSystem 接口的存档约定。对话进行中或演出进行中的状态无法通过存档/读档恢复。违反原则：**接口约定**（同 P7）。

### 8. 其他（文档同步 / 职责）

- [ ] **[P13]** 位置：`游戏架构设计文档.md` 第三章。代码已新增 `GameStateController`（管理游戏状态机、UI 面板注册、快捷键、Escape 处理），但架构文档中无对应章节描述。文档与代码不一致。

- [ ] **[P14]** 位置：`游戏架构设计文档.md` 3.2 节事件清单。代码中大量实际使用的事件未在文档中列出，包括但不限于：
  - 交互相关：`hotspot:triggered`、`npc:interact`、`hotspot:pickup:done`、`hotspot:inspected`
  - 对话相关：`dialogue:line`、`dialogue:willEnd`、`dialogue:advance`、`dialogue:advanceEnd`、`dialogue:choiceSelected:log`
  - 演出相关：`cutscene:start`、`cutscene:end`
  - 区域相关：`zone:enter`、`zone:exit`、`zone:ruleAvailable`、`zone:ruleUnavailable`
  - 规矩使用：`rule:used`、`ruleUse:showResult`
  - 商店/菜单：`shop:purchase`、`inventory:discard`、`menu:newGame`、`menu:returnToMain`

  文档事件清单应与代码实际事件保持同步。

- [ ] **[P15]** 位置：`游戏架构设计文档.md` 3.2 节。`dialogue:start` 事件 payload 写为 `{ npcId }`，但代码实际使用 `{ npcName }`。且文档内部 3.2 节（写 npcId）与 5.3 节（写 "NPC 名称字符串"）互相矛盾。应统一修正为 `{ npcName }`。

- [ ] **[P16]** 位置：`游戏架构设计文档.md` 第八章目录结构。缺少 `game_config.json`（已存在于 `public/assets/data/`）。3.6 节 InputManager 描述仍写 "快捷键映射当前写在 Game.ts 中"，实际已迁移至 `GameStateController`。

---

## 按优先级排序

| 优先级 | ID | 类型 | 概述 |
|--------|-----|------|------|
| 高 | P1 | 耦合 | SceneManager→InteractionSystem 同层直接依赖 |
| 高 | P2/P11 | 耦合+分层 | RuleUseUI 直接持有并调用 ActionExecutor |
| 高 | P7/P12 | 生命周期+接口 | DialogueManager/CutsceneManager 空 serialize/deserialize |
| 中 | P3 | 分层违反 | CutsceneManager 直接操作 PixiJS 渲染对象 |
| 中 | P9 | 数据驱动 | RulesPanelUI 硬编码规矩分类名 |
| 中 | P10 | 数据驱动 | LoreBookUI 硬编码见闻分类名 |
| 中 | P13-P16 | 文档同步 | 架构文档多处与代码不一致 |
| 低 | P4 | 生命周期 | FlagStore 缺 destroy() |
| 低 | P5 | 生命周期 | ActionExecutor 缺 destroy() |
| 低 | P6 | 生命周期 | Game.destroy() 未调用 eventBus.clear() |
| 低 | P8 | 数据驱动 | 系统层硬编码通知文案（本地化债务） |

---

## 总体评价

经过本轮重构后，代码库在以下方面有显著改善：
- **系统解耦**：12 个系统全部实现 IGameSystem，EncounterManager 不再直接引用 RulesManager
- **UI 解耦**：7 个只读数据接口有效隔离了 UI 与系统实现，状态变更改为事件驱动
- **统一动作执行**：pickup、switchScene、CutsceneManager 指令等均走 ActionExecutor
- **生命周期**：Game.destroy() 完整，事件监听全部通过存储引用确保可清理
- **数据驱动**：game_config.json 替代了硬编码的初始场景和任务
- **职责拆分**：GameStateController 承接了 Game.ts 的状态机和 UI 切换逻辑

剩余问题集中在：SceneManager 对 InteractionSystem 的直接依赖（同层耦合的最后一处）、RuleUseUI 越层执行动作、CutsceneManager 直接操作渲染对象、以及架构文档与代码的同步滞后。

---

## 下一步

当前仅做审查与报告，未修改任何业务代码。如需开始修复，请回复「开始修复」。
