# 架构审查报告

**审查时间戳：** 2026-03-22 23:30

## 文档同步说明

- 逐项核对目录结构、系统列表、事件清单、UI 面板表、配置驱动清单、数据提供者接口（IQuestDataProvider 等）、四个 core 提取模块描述、EmoteBubbleManager 辅助模块说明。
- **全部一致，无需同步。**（上一轮审查已完成 `rule:used` 移除、`assetPath.ts` 和 `PlaceholderFactory.ts` 补充。）

## 问题列表

### 1. 耦合

- 未发现。UI 间无相互 import；同层系统间无直接持有（EmoteBubbleManager 作为辅助模块由 Game 注入 CutsceneManager，使用 type-only import，文档 5.9.1 已说明）。

### 2. 过度设计

- 未发现。

### 3. 分层违反

- 未发现。所有 UI 类型依赖均从 `data/types.ts` 导入；渲染层和实体层无上层依赖。

### 4. 生命周期与销毁

- [x] **位置**：`src/ui/PickupNotification.ts`。**已修复**：`tick()` 中增加 `activeNotifications.includes(container)` 守卫，`forceCleanup()` 清空列表后 rAF 自动停止。
- [x] **位置**：`src/rendering/CutsceneRenderer.ts`。**已修复**：新增 `pendingRafIds`/`pendingTimerIds` 集合和 `trackRaf()` 辅助方法，所有 `requestAnimationFrame` 改为 `trackRaf()`，`wait()` 中 `setTimeout` 改为追踪版本，`cleanup()` 头部统一 `cancelAnimationFrame`/`clearTimeout` 并清空集合。
- [x] **位置**：`src/ui/ShopUI.ts`。**已修复**：新增 `rebuildTimerId` 字段，`doPurchase()` 保存 setTimeout ID，`destroy()` 中 `clearTimeout`。
- [x] **位置**：`src/ui/InspectBox.ts`。**已修复**：新增 `showTimerId` 字段，`show()` 保存 setTimeout ID，`close()` 中 `clearTimeout`。

### 5. 数据驱动与配置驱动

- 未发现。所有面向玩家的中文文案已迁移到 `strings.json`（DebugPanelUI 保留硬编码属于调试工具，非玩家功能）。

### 6. 统一动作执行

- 未发现。InteractionCoordinator 已改走 ActionExecutor；EventBridge 已改走 ActionExecutor。

### 7. 接口与约定

- 未发现。所有 IGameSystem 实现者生命周期完整（EmoteBubbleManager 作为辅助模块例外已记录于文档）。

### 8. 其他

- 未发现循环依赖、全局单例滥用或职责混杂问题。
- 事件命名与文档完全一致。

## 修复完成

所有 4 项问题均已修复。`tsc --noEmit` + `npm run build` 全部通过。
