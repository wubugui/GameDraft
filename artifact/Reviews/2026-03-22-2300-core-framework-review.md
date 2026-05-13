# 架构审查报告

**审查时间戳：** 2026-03-22 23:00

## 文档同步说明

- 移除事件清单中 `rule:used` 事件（代码中无任何发布/订阅，规矩使用走 `ruleUse:apply`）。
- 补充 `assetPath.ts` 到目录结构 core/ 区段（资源路径解析工具函数）。
- 补充 `PlaceholderFactory.ts` 到目录结构 rendering/ 区段（占位背景与占位玩家纹理生成）。
- 其余内容（系统列表、事件清单、UI 面板表、配置驱动清单、四个 core 提取模块描述）与代码一致，无需额外同步。

## 问题列表

### 1. 耦合

- 未发现。BookshelfUI 已解耦子面板依赖；同层系统间无直接持有（EmoteBubbleManager 作为辅助模块由 Game 注入 CutsceneManager，使用 type-only import，已在文档 5.9.1 说明）。

### 2. 过度设计

- 未发现。

### 3. 分层违反

- 未发现。所有 UI 的类型依赖均从 `data/types.ts` 导入；渲染层和实体层无上层依赖。

### 4. 生命周期与销毁

- [x] **位置**：`src/systems/SceneManager.ts`。**已修复**：`animateAlpha()` 新增 `animRafId` 字段，保存 rAF ID；每次调用前先 `cancelAnimationFrame`；`destroy()` 中主动取消进行中的动画帧。
- [x] **位置**：`src/systems/AudioManager.ts`。**已修复**：新增 `pendingTimers` 集合和 `scheduleCleanup()` 辅助方法，所有 `setTimeout` 改为 `scheduleCleanup` 调用；`destroy()` 中统一 `clearTimeout` 并清空集合。

### 5. 数据驱动与配置驱动

- [x] **位置**：`src/ui/MenuUI.ts`。**已修复**：存档槽位信息模板迁移到 `strings.json` 的 `menu.slotInfo`，MenuUI 使用 `this.strings.get('menu', 'slotInfo', {...})` 读取。
- [x] **位置**：`src/core/SaveManager.ts`。**已修复**：`'未知'` fallback 迁移到 `strings.json` 的 `menu.unknownScene`；SaveManager 新增 `StringsProvider` 构造参数，通过 `this.strings.get('menu', 'unknownScene')` 读取。

### 6. 统一动作执行

- [x] **位置**：`src/core/InteractionCoordinator.ts`。**已修复**：`handlePickup()` 中的 `flagStore.set()` 改为 `actionExecutor.execute({ type: 'setFlag', params: {...} })`；同时从 `InteractionDeps` 接口和 Game.ts 组装处移除不再需要的 `flagStore` 依赖。

### 7. 接口与约定

- 未发现新问题。所有 IGameSystem 实现者生命周期完整（EmoteBubbleManager 作为辅助模块例外已记录于文档）。

### 8. 其他

- 未发现循环依赖、全局单例滥用或职责混杂问题。
- 事件命名与文档一致（已同步移除 `rule:used`）。

## 修复完成

所有 5 项问题均已修复。`tsc --noEmit` + `npm run build` 全部通过。
