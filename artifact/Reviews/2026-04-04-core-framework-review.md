# 架构审查报告

**审查时间戳：** 2026-04-04 15:30

## 文档同步说明

- 逐项核对：目录结构、系统列表、事件清单、IGameSystem 实现者、IEmoteBubbleProvider/setEmoteBubbleProvider、扩展性示例（npcs、scene:enter payload）均与代码一致。
- **无需同步。**

## 问题列表

### 1. 耦合

- 未发现。CutsceneManager 已通过 IEmoteBubbleProvider 接口解耦对 EmoteBubbleManager 的直接依赖。InteractionCoordinator 和 EventBridge 作为协调层有效隔离了系统间直接耦合。

### 2. 过度设计

- 未发现。抽象层都有明确用途，没有发现多余的框架式扩展点或重复机制。

### 3. 分层违反

- 未发现。渲染层不依赖系统层，系统层通过 Renderer 提供的接口操作渲染，UI 层通过只读数据接口访问系统数据。

### 4. 生命周期与销毁

- [ ] **位置**：`src/core/Game.ts` L340-345、L619-660。`destroy()` 方法中未移除 `renderer.app.ticker.add()` 注册的回调。当前依赖 `renderer.destroy()` 中的 `app.destroy(true)` 停止 ticker，但在销毁 systems 与 destroy renderer 之间，若有未执行的 rAF 帧，ticker 回调仍可能触发，导致 `tick()` 访问已销毁的 `sceneManager` 等对象。**违反原则 #8**。

- [ ] **位置**：`src/core/Game.ts` L410-432。`runNpcPatrol()` 启动的 async 循环在 `await npc.moveTo()` 期间不可中断。若在等待期间发生场景卸载或 Game 销毁，`getCurrentNpcs()` 会变为空、npc 被销毁，循环恢复后可能访问已销毁的 npc 或 sceneManager。**违反原则 #8**。

### 5. 数据驱动与配置驱动

- 未发现。DebugPanelUI 中"收起"等文案为调试工具用，不计入玩家可见配置驱动违规。

### 6. 统一动作执行

- 未发现。遭遇结果、对话标签动作、区域进出动作都通过 ActionExecutor 执行。

### 7. 接口与约定

- [ ] **位置**：`src/systems/EmoteBubbleManager.ts`。文档写明实现 `IEmoteBubbleProvider`，代码中未显式 `implements IEmoteBubbleProvider`，仅结构上满足接口。建议补充显式实现以与文档和类型约定一致。

### 8. 其他

- 未发现循环依赖、全局单例、事件命名不一致或职责混杂问题。

## 下一步

当前仅完成审查与报告，未做任何代码修改。如需修复请回复「开始修复」。
