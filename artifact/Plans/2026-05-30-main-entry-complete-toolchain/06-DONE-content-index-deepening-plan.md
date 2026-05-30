# Content Index 深化小计划

## 目标

把 content index 从基础节点、边、条件、动作和引用关系，扩展到完整覆盖主入口工具链需要的引用、依赖、风险和运行时 ID 关系。

---

## 范围

本计划覆盖：

```text
1. 所有 action 类型的参数引用。
2. items / rules / archive / strings / audio / scenes 等 runtime 引用。
3. owner 边界。
4. 跨 owner 写入风险。
5. duplicate runtime id across legacy / pipeline。
```

本计划不覆盖：

```text
1. LSP UI provider。
2. Webview 具体渲染。
3. publish 执行动作。
```

---

## 前置依赖

```text
1. 现有 content index 可生成节点和边。
2. action / condition schema registry 有基本结构。
3. authoring 和 legacy 内容路径可枚举。
```

---

## 任务清单

### T1. 扩展 action 参数引用扫描

覆盖所有 action：

```text
1. graph / state 引用。
2. signal 引用。
3. scene / entity / zone 引用。
4. quest / item / rule 引用。
5. flag / context key 引用。
6. audio / string / archive 引用。
```

### T2. 扩展 runtime 引用索引

新增或补齐：

```text
1. items。
2. rules。
3. archive。
4. strings。
5. audio。
6. scenes。
7. anchors。
8. zones。
```

### T3. Owner 边界建模

为内容节点记录：

```text
1. ownerType。
2. ownerId。
3. 所属 scene / quest / graph。
4. pipeline-owned / legacy-owned 状态。
```

### T4. 跨 owner 写入风险

识别：

```text
1. action 写入其他 owner 的状态。
2. setFlag / setContextState 跨边界写入。
3. setNarrativeState 绕过 transition。
4. quest / scene 写入不属于自己的对象。
```

### T5. Duplicate runtime id 检查

扫描：

```text
1. pipeline 内容 runtime id。
2. legacy 内容 runtime id。
3. publish 输出 runtime id。
4. 重名但语义不同的风险。
```

---

## 输出物

```text
1. 完整 action reference index。
2. 扩展 runtime 引用索引。
3. owner boundary index。
4. cross-owner risk diagnostics。
5. duplicate runtime id diagnostics。
```

---

## 验收标准

```text
1. 任意 action 参数引用都能进入 index。
2. items / rules / archive / strings / audio / scenes 引用可以被索引和跳转。
3. 可以列出一个 owner 的读写边界。
4. 跨 owner 写入能被标记。
5. legacy / pipeline runtime id 重复能被发现。
```

---

## 风险点

```text
1. 旧内容字段不规范会产生不完整索引。
2. owner 边界规则需要和 publish ownership 对齐。
3. 重复 ID 可能存在历史合理例外，需要 allowlist 或降级策略。
```
