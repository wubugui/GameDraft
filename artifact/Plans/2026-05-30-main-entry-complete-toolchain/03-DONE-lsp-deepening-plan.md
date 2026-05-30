# LSP 深度化小计划

## 目标

把 LSP 从基础 diagnostics / completion / hover / definition / references 升级成内容开发的主入口能力。

---

## 范围

本计划覆盖：

```text
1. rename symbol。
2. code action。
3. semantic tokens。
4. document symbols。
5. workspace symbols。
6. 精确上下文补全。
7. 未保存文本增量诊断。
```

本计划不覆盖：

```text
1. Webview picker 实现。
2. Graph reference view 实现。
3. CI 命令最终编排。
```

---

## 前置依赖

```text
1. 现有 LSP server 可运行。
2. content index 可提供 symbol / reference / registry 查询。
3. diagnostics 能接收内存文档内容。
```

---

## 任务清单

### T1. 未保存文本诊断

建立文档缓存：

```text
1. didOpen 保存文本。
2. didChange 增量更新文本。
3. diagnostics 使用当前内存文本。
4. 磁盘文件作为未打开文档 fallback。
5. 文档版本和 diagnostics 对齐。
```

### T2. 精确上下文补全

按当前位置判断补全类型：

```text
1. signal: 位置只补 signal。
2. action type 位置补 action types。
3. action params 内补对应字段。
4. graphId 位置补 graph。
5. stateId 位置按 graph 补 state。
6. scene / entity / quest / flag 位置补对应 registry。
```

### T3. Rename symbol

支持重命名：

```text
1. graph id。
2. state id。
3. signal id。
4. flag id。
5. quest id。
6. scene / entity id。
```

每次 rename 输出 workspace edit，并保护只读或 pipeline-owned 文件。

### T4. Code action

优先实现：

```text
1. 创建缺失 signal。
2. 跳转或填充缺失 graph/state。
3. 为 ownerState 填 wrapperGraphId。
4. 修正废弃字段。
5. 删除无效引用。
```

### T5. Semantic tokens

标记：

```text
1. id。
2. reference。
3. action type。
4. condition type。
5. signal。
6. deprecated field。
```

### T6. Symbol providers

实现：

```text
1. document symbols。
2. workspace symbols。
3. symbol kind 映射。
4. container name。
```

---

## 输出物

```text
1. 增量文档诊断。
2. 上下文补全规则。
3. rename provider。
4. code action provider。
5. semantic tokens provider。
6. document / workspace symbol provider。
7. LSP smoke 测试。
```

---

## 验收标准

```text
1. 未保存修改能触发正确 diagnostics。
2. signal 字段只出现 signal 补全。
3. action params 中只出现该 action 合法字段。
4. rename 能更新所有可写引用。
5. code action 能修复至少一类真实 diagnostics。
6. document / workspace symbols 可用于快速跳转。
```

---

## 风险点

```text
1. rename 涉及跨文件写入，必须尊重 ownership。
2. 未保存文本和 content index 之间容易出现版本错位。
3. 语义 token 规则过细会增加维护成本。
```

