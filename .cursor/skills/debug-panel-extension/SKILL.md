---
name: debug-panel-extension
description: Adds features to the in-game debug panel based on user description. Use when the user asks to add debug panel functionality, 往debug面板添加功能, 添加debug功能, or similar. Implements minimal changes, runs subagent diff review, and reports for approval if changes are too large.
---

# Debug Panel Extension

根据用户描述向游戏内 Debug 面板添加功能。遵循最小改动原则，完成后由 subagent 根据 diff 做一次 review，改动过大时报告并征求用户意见。

## 何时使用

当用户请求以下类型时使用本技能：

- 往 debug 面板添加功能、区块、按钮
- 在 debug 面板中增加调试信息展示
- 添加 debug 快捷操作

## 核心原则：尽量不修改游戏逻辑

- **纯 debug 的变量和函数**：应放到 debug 专属位置（如 `DebugHelper` 模块、`setupDebugPanelSections` 闭包、`DebugPanelUI` 扩展），**不要**加入 Player、SceneManager、InteractionSystem 等游戏逻辑模块
- **获取/设置游戏状态**：如需读写游戏状态，可单独写函数（如 `getXxxForDebug()`、`setXxxForDebug()`），但这些函数应尽量集中在 Game 或专门的 debug 模块中，作为「debug 入口」
- **尽量避免**：在游戏逻辑类里新增 `private debugXxx` 成员、在 `update`/`tick` 里加 `if (debugMode)` 分支、在业务逻辑中混入 debug 专用逻辑

## 必须遵循的流程

### 1. 确认改动范围

- 目标仅限 Debug 面板：通过 `game.getDebugPanel().addSection()` 或修改 `setupDebugPanelSections()` 实现
- 不改动玩法逻辑、存档逻辑、其他 UI 或系统
- 不改动 `DebugPanelUI` 核心实现，除非用户明确要求扩展面板能力

### 2. 实现方式

**优先方式**：在 `Game.ts` 的 `setupDebugPanelSections()` 中新增 `addSection` 调用。

```typescript
this.debugPanelUI.addSection('SectionId', () => ({
  text: '描述文本',
  actions: [
    { label: '按钮名', fn: () => { /* 仅调用已有 API */ } },
  ],
}));
```

**约束**：

- 按钮回调中只调用 Game 已有的公开/私有方法、Manager 的公开接口
- 不新增依赖、不修改架构
- 如需访问 Game 内部成员，仅在 `setupDebugPanelSections` 所在类内通过 `this` 访问
- **debug 专属状态**：用闭包变量、`DebugPanelUI` 扩展、或独立的 `DebugHelper` 等模块承载，不往 Player/SceneManager 等游戏逻辑里塞

### 3. 改动过大判定

以下情况视为改动过大，须**先报告**并征求用户意见后再继续：

- 修改了 3 个以上文件
- 单文件净增超过 40 行
- 新增了 import 或依赖
- 修改了 `DebugPanelUI.ts` 的公开接口或核心逻辑
- 涉及 EventBus 新事件、FlagStore 新用法、ActionExecutor 新动作
- **在 Player、SceneManager、InteractionSystem 等游戏逻辑类中新增 debug 专用成员或分支**

### 4. 完成后必须执行

1. 实现完成后，运行 `git diff` 获取本次改动
2. **立即**调用 `mcp_task`，subagent_type 选 `generalPurpose`，prompt 格式：
   ```
   对以下 diff 做 code review，检查：是否影响其他逻辑、是否符合项目架构、是否有遗漏。
   输出简短结论：通过 / 需修复（并列出问题）/ 建议（可选）。
   
   --- diff 内容 ---
   [粘贴 git diff 输出]
   --- end ---
   ```
3. 将 subagent 的 review 结论汇报给用户

### 5. 若判定改动过大

1. 停止实现
2. 向用户报告：哪些改动触发了「过大」判定、建议的缩小方案
3. 征求用户意见：是否接受当前方案，或按建议缩小后再实现

## 参考

### Debug 面板 API

- `addSection(id, getter)`：`getter` 返回 `string` 或 `{ text: string; actions?: { label: string; fn: () => void }[] }`
- `log(msg)`：追加到日志区
- `refresh()`：刷新面板

### Debug 专属位置（放纯 debug 变量/逻辑）

- `setupDebugPanelSections` 内的闭包变量
- `Game` 中以 `debug` / `showXxxDebug` 等命名的私有成员（仅用于 debug 面板与 overlay）
- 必要时新建 `src/debug/DebugHelper.ts` 等独立模块

### Game 中可用的游戏 API

`sceneManager`, `inventoryManager`, `questManager`, `rulesManager`, `flagStore`, `actionExecutor`, `reloadScene`, `stateController`, `dayManager` 等

## 示例

用户：「在 debug 面板加一个跳转到茶楼的按钮」

实现：在 `setupDebugPanelSections` 中追加：

```typescript
{
  label: 'Go Teahouse',
  fn: () => {
    this.stateController.setState(GameState.Cutscene);
    this.sceneManager.switchScene('teahouse').then(() => {
      this.stateController.setState(GameState.Exploring);
    });
    this.debugPanelUI.log('Switched to teahouse');
  },
},
```

然后启动 subagent 对 diff 做 review，并将结果汇报用户。
