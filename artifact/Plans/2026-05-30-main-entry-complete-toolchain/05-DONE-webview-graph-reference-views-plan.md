# Graph Preview / Reference View Webview 小计划

## 目标

把主入口相关关系做成只读可视化 Webview，让复杂内容可以被阅读、诊断和追踪。

---

## 范围

本计划覆盖：

```text
1. signal flow view。
2. flag read/write view。
3. quest dependency view。
4. dialogue route explain view。
5. runtime trace timeline view。
```

本计划不覆盖：

```text
1. 可视化编辑 graph。
2. 空间 picker。
3. publish ownership 规则。
```

---

## 前置依赖

```text
1. content index 能提供引用关系。
2. simulator 能输出 trace report。
3. diagnostics 能定位 source location。
```

---

## 任务清单

### T1. Signal flow view

展示：

```text
1. signal source。
2. listened transition。
3. graph/state 迁移。
4. broadcastOnEnter 派生 signal。
5. 下游 listener。
```

### T2. Flag read/write view

展示：

```text
1. flag registry 类型。
2. read sites。
3. write sites。
4. setFlag value 类型。
5. 跨 owner 或危险写入提示。
```

### T3. Quest dependency view

展示：

```text
1. quest 状态流。
2. 依赖条件。
3. action 写入。
4. dialogue / scene / narrative 触发关系。
```

### T4. Dialogue route explain view

展示：

```text
1. entry 到当前 route。
2. choice option。
3. switch / ownerState / contextState 命中原因。
4. runActions diff 摘要。
```

### T5. Runtime trace timeline view

消费 simulator trace：

```text
1. timeline step。
2. action diff。
3. signal cascade。
4. final snapshot。
5. warning / error。
```

### T6. 跳转协议

每个节点支持：

```text
1. 跳到源 YAML。
2. 跳到 diagnostics。
3. 跳到相关 graph / state / action。
```

---

## 输出物

```text
1. signal flow Webview。
2. flag read/write Webview。
3. quest dependency Webview。
4. dialogue route explain Webview。
5. runtime trace timeline Webview。
6. source jump 协议。
```

---

## 验收标准

```text
1. 可以从 signal 看到上下游。
2. 可以从 flag 看到全部读写点。
3. 可以从 quest 看到依赖和触发链。
4. 可以从 dialogue 看到 route explain。
5. 可以打开 simulator trace timeline。
6. Webview 中节点可以跳回源文件。
```

---

## 风险点

```text
1. 可视化容易过载，需要默认聚焦当前对象。
2. 只读协议要明确，避免和可视化编辑混淆。
3. trace 数据量大时需要分页或折叠。
```

