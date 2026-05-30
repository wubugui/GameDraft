# Simulator 完整模拟小计划

## 目标

把 simulator 从 condition explain 扩展为可以复现主入口运行语义的完整模拟器。

完成后，给定一个 dialogue entry 和一组选择输入，工具应能跑出 dialogue route、分支命中、action diff、signal cascade，以及 narrative / quest 的后续变化。

---

## 范围

本计划覆盖：

```text
1. dialogue route 从 entry 到终点或阻塞点。
2. option 选择后的 route 推进。
3. switch / ownerState / contextState 命中解释。
4. runActions 执行前后 diff。
5. emit signal 后 narrative / quest 连锁变化。
6. trace report 输出。
```

本计划不覆盖：

```text
1. LSP 编辑体验。
2. Webview trace timeline 展示。
3. CI 命令统一编排。
```

---

## 前置依赖

```text
1. 当前 condition explain 可用。
2. 能加载 authoring 内容和 runtime registry。
3. 能调用或复用现有 action runner / dialogue runner / narrative state manager。
```

---

## 任务清单

### T1. 建立模拟输入模型

定义 simulator 输入：

```text
1. dialogueGraphId。
2. entry node。
3. ownerType / ownerId。
4. 初始 runtime snapshot。
5. option 选择序列。
6. 可选 signal / flag / quest 初始覆盖。
```

### T2. 跑 dialogue route

实现从 entry 逐步推进：

```text
1. line 节点记录文本和 next。
2. runActions 节点执行 action 并记录 diff。
3. choice 节点根据输入选择 option。
4. switch 节点记录 condition explain。
5. ownerState / contextState 节点记录 graph/state 命中。
6. end 或无法推进时停止。
```

### T3. 记录 action diff

每个 runActions 前后记录：

```text
1. flags diff。
2. contextState diff。
3. ownerState / narrative activeState diff。
4. quest state diff。
5. inventory / entity / scene 相关 diff。
```

### T4. 追踪 signal cascade

当 action emit signal 时，记录：

```text
1. signal 名称。
2. sourceType / sourceId。
3. 命中的 narrative graph transition。
4. 未命中的候选 transition 和原因。
5. 由 state broadcast 触发的二级 signal。
6. quest / narrative 后续变化。
```

### T5. 输出 trace report

输出结构化报告：

```text
1. route timeline。
2. 每步输入。
3. 每步命中原因。
4. action diff。
5. signal fan-out。
6. final snapshot。
7. warnings / errors。
```

---

## 输出物

```text
1. simulator trace API。
2. simulator CLI 或 workspace 命令入口。
3. JSON trace report。
4. 可读文本报告。
5. 至少一组 dialogue route 测试。
```

---

## 验收标准

```text
1. 给定 dialogue entry，能跑到 end 或明确阻塞点。
2. choice option 可以通过输入序列选择。
3. switch / ownerState / contextState 的命中原因可见。
4. runActions 前后 diff 可见。
5. emit signal 后 narrative / quest 连锁变化可见。
6. trace report 可以被后续 Webview timeline 复用。
```

---

## 风险点

```text
1. simulator 语义和真实 runtime 分叉。
2. action diff 粒度不稳定，导致报告噪声过大。
3. signal cascade 递归过深，需要限制深度和循环检测。
4. 老内容缺少 owner 上下文时需要清晰 fallback。
```

