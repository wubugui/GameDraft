# Publish / Ownership 最终化小计划

## 目标

把主入口时代的 ownership 和 publish 规则最终化，确保 pipeline-owned、legacy-owned、runtime compatibility 和只读 graph 入口之间边界清晰。

---

## 范围

本计划覆盖：

```text
1. pipeline-owned 和 legacy-owned 混合检查。
2. publish 前 runtime compatibility validator。
3. pipeline-owned 文件防手改提示。
4. graph 作为只读可视化入口的协议。
```

本计划不覆盖：

```text
1. content index 的底层引用扫描。
2. LSP rename 实现。
3. Webview graph 具体渲染。
```

---

## 前置依赖

```text
1. ownership 保护已有基础实现。
2. content index 能标记 pipeline / legacy 来源。
3. runtime compatibility 检查项可枚举。
```

---

## 任务清单

### T1. Ownership 状态模型

统一标记：

```text
1. pipeline-owned。
2. legacy-owned。
3. generated。
4. manually editable。
5. readonly visualization source。
```

### T2. 混合检查

检查：

```text
1. 同一 runtime id 同时来自 pipeline 和 legacy。
2. pipeline-owned 输出被 legacy 手改覆盖。
3. legacy-owned 内容被 pipeline 引用但未声明迁移。
4. generated 文件被手工修改。
```

### T3. Runtime compatibility validator

publish 前检查：

```text
1. runtime id 唯一。
2. graph/state/action schema 兼容 runtime。
3. 旧字段有兼容策略。
4. 必需 registry 完整。
5. publish 输出和 runtime loader 匹配。
```

### T4. 防手改提示

对 pipeline-owned 文件提供：

```text
1. diagnostics warning。
2. LSP hover 提示。
3. publish 前阻断或确认。
4. 指向正确 authoring 源。
```

### T5. Graph 只读可视化协议

定义：

```text
1. graph view 可以读取哪些索引。
2. graph view 不直接改 runtime 输出。
3. 修改必须回到 authoring 源。
4. graph 节点跳转源文件的规则。
```

---

## 输出物

```text
1. ownership 状态定义。
2. mixed ownership diagnostics。
3. runtime compatibility validator。
4. pipeline-owned 防手改 diagnostics。
5. readonly graph view 协议文档。
```

---

## 验收标准

```text
1. pipeline-owned 和 legacy-owned 混合风险可被发现。
2. publish 前会运行 runtime compatibility validator。
3. 手改 pipeline-owned 文件会被提示。
4. graph view 明确只读，并能跳回 authoring 源。
5. publish 阶段能说明每个阻断项来自哪条规则。
```

---

## 风险点

```text
1. ownership 规则过严会阻塞历史内容维护。
2. runtime compatibility 需要和真实 loader 行为保持一致。
3. 只读 graph 协议如果不清楚，会诱导用户期待可视化编辑。
```

