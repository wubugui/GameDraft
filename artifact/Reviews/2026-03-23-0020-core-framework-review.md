# 架构审查报告

**审查时间戳：** 2026-03-23 00:20

## 文档同步说明

- 逐项核对：目录结构、系统列表、事件清单、IGameSystem 实现者、IEmoteBubbleProvider/setEmoteBubbleProvider、扩展性示例（npcs、scene:enter payload）均与代码一致。
- **无需同步。**

## 问题列表

### 1. 耦合

- 未发现。CutsceneManager 已通过 IEmoteBubbleProvider 接口解耦对 EmoteBubbleManager 的直接依赖。

### 2. 过度设计

- 未发现。

### 3. 分层违反

- 未发现。

### 4. 生命周期与销毁

- [ ] **位置**：`src/core/Game.ts` L320、L532-568。`destroy()` 未在开头移除 `renderer.app.ticker.add()` 注册的回调。当前依赖 `renderer.destroy()` 中的 `app.destroy(true)` 停止 ticker，但在销毁 systems 与 destroy renderer 之间，若有未执行的 rAF 帧，ticker 回调仍可能触发，导致 `tick()` 访问已销毁的 `sceneManager` 等对象。**违反原则 #8**。
- [ ] **位置**：`src/core/Game.ts` L391-412。`runNpcPatrol()` 启动的 async 循环在 `await npc.moveTo()` 期间不可中断。若在等待期间发生场景卸载或 Game 销毁，`getCurrentNpcs()` 会变为空、npc 被销毁，循环恢复后可能访问已销毁的 npc 或 sceneManager。**违反原则 #8**。

### 5. 数据驱动与配置驱动

- 未发现。DebugPanelUI 中「关闭」等文案为调试工具用，不计入玩家可见配置驱动违规。

### 6. 统一动作执行

- 未发现。

### 7. 接口与约定

- [ ] **位置**：`src/systems/EmoteBubbleManager.ts`。文档写明实现 `IEmoteBubbleProvider`，代码中未显式 `implements IEmoteBubbleProvider`，仅结构上满足接口。建议补充显式实现以与文档和类型约定一致。

### 8. 其他

- [x] **位置**：`src/systems/SceneManager.ts`。**已修复**：`loadScene` 新增可选参数 `fromSceneId`，`switchScene` 调用时传入正确的 `fromSceneId` 并移除重复的 `scene:enter`  emit，场景切换时只发出一次且 payload 正确。

## 下一步

当前仅完成审查与报告，未做任何代码修改。如需修复请回复「开始修复」。
