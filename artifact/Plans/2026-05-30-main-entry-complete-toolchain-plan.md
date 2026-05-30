# 主入口完整工具链迭代计划

## 拆分计划

本计划已拆成可单独执行的小计划，放在：

```text
artifact/Plans/2026-05-30-main-entry-complete-toolchain/
```

入口索引：

```text
artifact/Plans/2026-05-30-main-entry-complete-toolchain/00-index.md
```

## 0. 目标

把当前“主入口”相关能力补成一条闭环工具链，让内容从编辑、校验、模拟、可视化、发布到 CI 检查都能串起来。

本计划按以下口径整理：

```text
1. 主入口不是单一功能，而是一条从内容到运行时再到发布的完整链路。
2. Simulator 负责验证运行时语义闭环。
3. schema 校验负责提前拦住参数级错误。
4. LSP 负责编辑期诊断、导航、补全和重构入口。
5. Webview picker / graph preview 负责把复杂内容变成可读、可选、可追踪。
6. content index 负责把内容关系、依赖、风险和重复 ID 系统化。
7. ownership / publish 负责把可改写边界收紧到主入口时代的规则。
8. 真实内容 DSL 负责倒逼功能补缺，而不是只在样例上成立。
9. CI / workspace 命令负责把整条链纳入一键检查。
```

---

## 1. 当前缺口总览

### 1.1 Simulator 还没补完整

当前已经能做 condition explain，但还缺完整模拟闭环：

```text
1. dialogue route 从 entry 走完整流程。
2. 选择某个 option 后的路由变化。
3. switch / ownerState / contextState 命中分支。
4. runActions 前后 diff。
5. emit signal 后 narrative / quest 的连锁变化。
```

### 1.2 Action / Condition schema 校验不够强

目前能扫引用，但还没做到 action 参数级校验，例如：

```text
1. moveEntityTo.x / y 类型与范围校验。
2. startDialogueGraph.graphId 存在性校验。
3. switchScene.targetScene 存在性校验。
4. setFlag.value 类型是否符合 flag registry。
```

### 1.3 LSP 仍是可用版，不是最终深度版

已支持：

```text
diagnostics
completion
hover
definition
references
```

还缺：

```text
1. rename symbol。
2. code action。
3. semantic tokens。
4. document symbols / workspace symbols。
5. 更精确的上下文补全。
6. 从未保存文本做完整增量诊断。
```

### 1.4 VS Code Webview picker 还只是位置 picker

地图点选已经有了，但还没覆盖所有空间字段：

```text
1. polygon picker / editor。
2. patrol route picker。
3. spawn point picker。
4. zone picker。
5. entity picker。
6. anchor registry picker。
7. 从当前 YAML 字段识别要 pick 的类型。
```

### 1.5 Graph preview / reference view 还没做成 Webview

可视化编辑不是重点，但可视化阅读和诊断是刚需。还缺：

```text
1. signal flow view。
2. flag read/write view。
3. quest dependency view。
4. dialogue route explain view。
5. runtime trace timeline view。
```

### 1.6 Content index 还能继续加深

已有节点、边、条件、动作和引用关系，但还没完整覆盖：

```text
1. 所有 action 类型的参数引用。
2. items / rules / archive / strings / audio / scenes 等 runtime 引用。
3. owner 边界和跨 owner 写入风险。
4. duplicate runtime id across legacy / pipeline。
```

### 1.7 Publish / ownership 还没最终化

现在有 ownership 保护，但主入口时代的规则还不完整：

```text
1. pipeline-owned 和 legacy-owned 混合检查。
2. publish 前 runtime compatibility validator。
3. pipeline-owned 文件防手改提示。
4. graph 作为只读可视化入口的协议。
```

### 1.8 真实内容 DSL 还很少

当前 authoring 里样例量级还不够。需要在真实迁移过程中补 DSL 表达缺口。

### 1.9 CI / workspace 命令还没串完整

还没把这些正式纳入一键检查链：

```text
1. content build。
2. diagnostics-json。
3. LSP smoke。
4. VS Code extension compile。
5. simulator tests。
6. runtime compatibility tests。
```

---

## 2. 总体实施顺序

建议按 6 个阶段推进：

```text
阶段 1：Simulator 闭环补全
阶段 2：Action / Condition schema 参数级校验
阶段 3：LSP 深度化
阶段 4：Webview picker 与 Graph preview
阶段 5：Content index 深化与 ownership / publish 收口
阶段 6：真实 DSL 迁移与 CI / workspace 一键链路
```

每个阶段都尽量满足：

```text
1. 运行时可用。
2. 编辑器可见。
3. 校验能拦截错误。
4. 老内容有兼容或迁移策略。
5. 有最小验收场景。
```

---

## 3. 阶段 1：Simulator 闭环补全

### 目标

把 simulator 从“能解释 condition”升级成“能跑完整主入口链路”的验证器。

### 需要补的能力

```text
1. 从 dialogue entry 开始跑完整 route。
2. option 选择后的分支追踪。
3. switch / ownerState / contextState 的命中解释。
4. runActions 前后 diff。
5. emit signal 后的连锁推进。
6. narrative / quest / related graph 的级联变化。
```

### 关键输出

```text
1. route timeline。
2. 每一步命中的原因解释。
3. action 执行前后状态差异。
4. signal fan-out 结果。
5. 失败原因和未命中分支说明。
```

### 验收标准

```text
1. 给定一个 dialogue entry，能一次性跑到终点或阻塞点。
2. 能看到每个 option 选择后 route 的变化。
3. 能看到 switch / ownerState / contextState 的命中链。
4. 能看到 emit signal 之后引发的后续变化。
5. 能输出可读的 trace report。
```

---

## 4. 阶段 2：Action / Condition schema 参数级校验

### 目标

从“引用存在就算过”升级到“参数形状、类型、取值域都正确”。

### 需要补的校验

```text
1. action 参数字段级校验。
2. 条件表达式字段级校验。
3. 不同 action 类型对应不同 schema。
4. registry 关联字段和枚举项校验。
5. context 相关的目标对象存在性校验。
```

### 示例校验项

```text
1. moveEntityTo.x / y 必须是数值。
2. startDialogueGraph.graphId 必须存在。
3. switchScene.targetScene 必须存在且可发布。
4. setFlag.value 必须符合 flag registry 类型。
5. 条件中引用的 id / key 必须落在当前 registry 范围。
```

### 验收标准

```text
1. 参数类型错能报错。
2. 存在性错能报错。
3. 枚举值不合法能报错。
4. 旧样例不会因为宽松字段被误判为通过。
5. 校验输出能定位到具体 action / condition 节点。
```

---

## 5. 阶段 3：LSP 深度化

### 目标

把 LSP 从基础导航工具升级成真正可用的内容开发接口。

### 需要补的能力

```text
1. rename symbol。
2. code action。
3. semantic tokens。
4. document symbols。
5. workspace symbols。
6. 更精确的上下文补全。
7. 从未保存文本进行增量诊断。
```

### 上下文补全要求

补全不再是“泛化列表”，而是按位置收敛：

```text
1. 在 signal: 位置只补 signal。
2. 在 action params 内只补对应字段。
3. 在 graph / state / scene / entity 引用位置只补匹配 registry。
4. 在字符串模板内按上下文给出候选。
```

### 增量诊断要求

```text
1. 编辑中的未保存文本要能诊断。
2. 磁盘文件只是 fallback，不是唯一真源。
3. 增量更新要和当前文档版本对齐。
```

### 验收标准

```text
1. 可以重命名 symbol 且引用同步更新。
2. 可以看到结构化 symbol tree。
3. 可以按上下文拿到更窄的补全结果。
4. 未保存修改也能得到正确 diagnostics。
5. 语义高亮可以区分关键字段与普通文本。
```

---

## 6. 阶段 4：Webview picker 与 Graph preview

### 目标

把复杂字段的选择、阅读和诊断都放进 Webview，降低 YAML 手填成本和误用概率。

### Picker 扩展

```text
1. polygon picker / editor。
2. patrol route picker。
3. spawn point picker。
4. zone picker。
5. entity picker。
6. anchor registry picker。
7. 基于当前 YAML 字段自动识别 picker 类型。
```

### Graph preview 扩展

```text
1. signal flow view。
2. flag read/write view。
3. quest dependency view。
4. dialogue route explain view。
5. runtime trace timeline view。
```

### 设计原则

```text
1. 读取和诊断优先于编辑。
2. picker 只负责减少手工输入，不替代 schema。
3. graph view 用来解释关系，不替代真数据结构。
4. 字段识别优先于手动模式选择。
```

### 验收标准

```text
1. 能从字段上下文自动弹出正确 picker。
2. 能直接查看 signal / quest / flag / route 的依赖图。
3. 能从 graph view 反查引用源。
4. 能在 Webview 中读懂一条 runtime trace。
```

---

## 7. 阶段 5：Content index 深化与 ownership / publish 收口

### 目标

把内容关系、写入边界和发布边界统一进索引和策略层。

### Content index 需要补的范围

```text
1. 所有 action 类型的参数引用。
2. items / rules / archive / strings / audio / scenes 等 runtime 引用。
3. owner 边界与跨 owner 写入风险。
4. duplicate runtime id across legacy / pipeline。
```

### Ownership / publish 需要补的规则

```text
1. pipeline-owned 和 legacy-owned 混合检查。
2. publish 前 runtime compatibility validator。
3. pipeline-owned 文件防手改提示。
4. graph 作为只读可视化入口的协议。
```

### 验收标准

```text
1. 可以完整列出一条内容的写入和读取边界。
2. 可以定位跨 owner 风险。
3. 可以识别 legacy / pipeline 混合的危险区。
4. publish 前可以做 runtime compatibility 检查。
5. pipeline-owned 文件能给出明确防手改提示。
```

---

## 8. 阶段 6：真实 Graph DSL 迁移与 CI / workspace 一键链路

### 目标

用真实 graph 内容迁移补齐 DSL 缺口，并把整条链纳入一键检查。普通 runtime 数据不纳入全量表迁移。

### 真实 DSL 迁移要求

```text
1. 以真实 graph 内容迁移倒逼表达缺口。
2. 不只维护样例，要覆盖真实 authoring 场景。
3. 迁移时持续补 action / condition / graph 表达能力。
```

### CI / workspace 命令链

```text
1. content build。
2. diagnostics-json。
3. LSP smoke。
4. VS Code extension compile。
5. simulator tests。
6. runtime compatibility tests。
```

### 验收标准

```text
1. 一键命令可以跑完整检查链。
2. CI 能看到每个阶段的失败点。
3. 真实 graph 内容迁移能持续推动 schema 和工具补全。
4. 构建、诊断、模拟、扩展编译、兼容性测试都能串起来。
```

---

## 9. 里程碑建议

### M1：主入口模拟闭环

```text
Simulator + dialogue route + option + action diff + signal cascade
```

### M2：参数级校验上线

```text
Action / Condition schema 校验 + registry 约束
```

### M3：LSP 深度版

```text
rename + code action + semantic tokens + 精确补全 + 未保存增量诊断
```

### M4：Webview 读取与选择闭环

```text
picker + graph preview + runtime trace view
```

### M5：索引与发布规则收口

```text
content index 深化 + ownership/publish 规则
```

### M6：真实 DSL + CI 一键链路

```text
真实迁移 + content build + diagnostics-json + LSP smoke + extension compile + tests
```

---

## 10. 风险点

### 11.1 Simulator 语义漂移风险

如果 trace 和 runtime 不一致，会导致“看起来能跑，实际上没跑对”。

### 11.2 校验过严导致旧内容大量告警

参数级校验要分阶段落地，避免一次性把历史内容全打爆。

### 11.3 LSP 与磁盘文件真源不一致

未保存文本必须纳入诊断链，否则编辑器体验会出现明显断层。

### 11.4 Webview picker 过度定制

不要把 picker 做成另一套编辑器。它应该减少误选，不是替代 schema。

### 11.5 只做样例不做真实 DSL

如果不在真实迁移里补缺口，工具链会停留在 demo 级。

### 11.6 CI 链路碎片化

如果 build / diagnostics / smoke / tests 各自独立，主入口闭环就不会真正成立。

---

## 11. 完成标准

最终完成时，主入口工具链应满足：

```text
1. 内容能从 authoring 到 runtime 全链路验证。
2. Simulator 能解释并复现主入口语义。
3. schema 能拦住参数级错误。
4. LSP 能支撑真实内容开发。
5. Webview 能读懂复杂关系并辅助选择。
6. content index 能说明谁读、谁写、谁依赖、谁有风险。
7. ownership / publish 能约束主入口时代的写入边界。
8. 真实 DSL 迁移能持续倒逼能力补齐。
9. CI / workspace 命令能一键覆盖关键链路。
```
