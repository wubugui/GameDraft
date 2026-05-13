# 架构审查报告

**审查时间戳：** 2026-03-23 00:10

## 文档同步说明

- `scene:enter` 事件 payload 补充 `sceneName` 字段，与代码（SceneManager L222、269）一致。
- 扩展性示例「添加一个新 NPC」：删除不存在的 `npcs.json` 步骤，改为在场景 JSON 的 `npcs` 数组中添加 NPC 放置点，并补充 archive/characters.json 说明。

## 问题列表

### 1. 耦合

- [x] **位置**：`src/systems/CutsceneManager.ts`。**已修复**：在 `data/types` 中新增 `IEmoteBubbleProvider` 接口，CutsceneManager 改为依赖该接口并接收 `setEmoteBubbleProvider()` 注入，不再直接导入 `EmoteBubbleManager`。

### 2. 过度设计

- 未发现。

### 3. 分层违反

- 未发现。

### 4. 生命周期与销毁

- 未发现。各系统与 UI 的 eventBus 订阅、window 监听、setTimeout、requestAnimationFrame 均在 destroy/cleanup 中正确清理。PickupNotification 的 rAF 链在 `forceCleanup()` 清空 `activeNotifications` 后，通过守卫自然退出，无残留操作。

### 5. 数据驱动与配置驱动

- [x] **位置**：`src/systems/ArchiveManager.ts`。**已修复**：`tryUnlockCharacterByNpc()` 与 `evaluateUnlocks()` 在解锁时补充调用 `flagStore.set()` 同步至 FlagStore，与 `addEntry()` 行为一致。

### 6. 统一动作执行

- 未发现。

### 7. 接口与约定

- 未发现。

### 8. 其他

- 未发现循环依赖、全局单例滥用、事件命名不一致或职责混杂问题。

## 下一步

当前仅完成审查与报告，未做任何代码修改。如需修复请回复「开始修复」。
