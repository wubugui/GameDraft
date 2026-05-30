# Action / Condition Schema 参数级校验小计划

## 目标

把当前引用扫描升级为参数级 schema 校验，让每种 action 和 condition 都能检查字段、类型、registry 引用和上下文约束。

---

## 范围

本计划覆盖：

```text
1. action 参数字段级校验。
2. condition 表达式字段级校验。
3. registry 类型和枚举约束。
4. graph / scene / entity / flag / signal 等引用存在性。
5. diagnostics 输出定位到具体 action / condition。
```

本计划不覆盖：

```text
1. LSP UI 展示。
2. Webview graph 展示。
3. 真实内容迁移本身。
```

---

## 前置依赖

```text
1. 当前 content diagnostics 可以扫描引用。
2. action type 列表可枚举。
3. flag registry / graph registry / scene registry 等索引可读取。
```

---

## 任务清单

### T1. 整理 action schema registry

为每种 action 定义参数约束：

```text
1. required 字段。
2. optional 字段。
3. 字段类型。
4. registry 引用类型。
5. 取值范围。
6. 废弃字段提示。
```

优先覆盖：

```text
moveEntityTo
startDialogueGraph
switchScene
setFlag
emitNarrativeSignal
setNarrativeState
```

### T2. 整理 condition schema registry

覆盖常用 condition：

```text
1. flag condition。
2. narrative graph/state condition。
3. ownerState / contextState 相关 condition。
4. quest state condition。
5. inventory / entity / scene condition。
```

### T3. 接入 registry 类型校验

示例规则：

```text
1. moveEntityTo.x / y 必须是 number。
2. startDialogueGraph.graphId 必须存在。
3. switchScene.targetScene 必须存在。
4. setFlag.value 必须符合 flag registry 类型。
5. emitNarrativeSignal.signal 必须是登记 signal 或允许的派生 signal。
```

### T4. 输出结构化 diagnostics

每条问题包含：

```text
1. severity。
2. code。
3. message。
4. source file。
5. path / node id / action index。
6. quick fix hint。
```

### T5. 增加测试样例

覆盖：

```text
1. 缺字段。
2. 类型错误。
3. registry 引用不存在。
4. flag value 类型不匹配。
5. 废弃字段 warning。
```

---

## 输出物

```text
1. action schema registry。
2. condition schema registry。
3. 参数级 validator。
4. diagnostics-json 输出增强。
5. 校验测试。
```

---

## 验收标准

```text
1. 参数类型错能报错。
2. 引用不存在能报错。
3. 枚举值不合法能报错。
4. flag value 类型不匹配能报错。
5. 问题能定位到具体 action / condition。
6. 旧内容可以通过 warning 分阶段消化。
```

---

## 风险点

```text
1. 一次性校验过严导致历史内容大量失败。
2. action 参数存在历史别名，需要兼容层。
3. registry 缺失时容易误报，需要区分 unknown registry 和 invalid reference。
```

