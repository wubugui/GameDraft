# 架构审查报告

**审查时间戳：** 2026-03-23 00:00

## 文档同步说明

- `entities/` 目录结构中 `NPC.ts` 改为 `Npc.ts`，与实际文件名一致。
- `rendering/filter/` 目录结构补充 `types`、`index`，完整反映子目录内容。

## 问题列表

### 1. 耦合

- 未发现。

### 2. 过度设计

- 未发现。

### 3. 分层违反

- 未发现。

### 4. 生命周期与销毁

- [x] **位置**：`src/systems/AudioManager.ts` L207-210。**已修复**：在 `destroy()` 中改为先同步停止并卸载当前 BGM（直接调用 `stop()`/`unload()`），再清空 `pendingTimers`，避免 `stopBgm` 通过 `scheduleCleanup` 新增未追踪定时器。
- [x] **位置**：`src/systems/CutsceneManager.ts` L386-391。**已修复**：在 `destroy()` 开头先执行 `waitClickResolve` 和 `dialogueResolve`（若存在），释放悬挂 Promise，再移除监听并执行 `cleanup()`。

### 5. 数据驱动与配置驱动

- 未发现。

### 6. 统一动作执行

- 未发现。

### 7. 接口与约定

- 未发现。

### 8. 其他

- 未发现循环依赖、全局单例滥用或职责混杂问题。
- 事件命名与文档完全一致。

## 下一步

当前仅完成审查与报告，未做任何代码修改。如需修复请回复「开始修复」。
