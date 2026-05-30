# 真实 Graph DSL 迁移小计划

## 目标

用真实 graph 内容迁移验证并补齐 DSL 表达能力，让工具链不只在样例内容上成立。

---

## 范围

本计划覆盖：

```text
1. 选择真实内容迁移批次。
2. 记录 DSL 表达缺口。
3. 补 action / condition / graph 表达。
4. 更新 authoring 内容。
5. 用 simulator / diagnostics / publish 检查迁移结果。
```

本计划不覆盖：

```text
1. 一次性迁移所有内容。
2. 大范围改 runtime 语义。
3. 可视化编辑器重写。
4. items / rules / archive / strings / audio / scenes 等普通 runtime 数据表迁移。
```

---

## 前置依赖

```text
1. 基础 authoring DSL 可构建。
2. diagnostics-json 可运行。
3. simulator 至少能跑核心 route。
4. publish compatibility validator 有基本入口。
```

---

## 任务清单

### T1. 选择迁移批次

每批选择一个闭环内容：

```text
1. 一个闭环 graph / flow。
2. 一个 dialogue graph。
3. 一个 quest。
4. 相关 narrative graph。
5. 相关 flags / signals / runtime 引用。
```

### T2. 记录表达缺口

每遇到无法表达的内容，记录：

```text
1. 原始内容位置。
2. 期望 DSL 表达。
3. 当前缺口。
4. 是否需要 runtime 支持。
5. 是否可以先用兼容字段。
```

### T3. 补 DSL 能力

优先补：

```text
1. action 类型。
2. condition 类型。
3. graph 状态读取。
4. quest dependency。
5. scene / entity / zone 引用。
```

### T4. 迁移内容

迁移后确保：

```text
1. authoring 内容可读。
2. runtime id 稳定。
3. 引用关系进入 content index。
4. diagnostics 可以定位问题。
```

### T5. 迁移验收

每批运行：

```text
1. content build。
2. diagnostics-json。
3. simulator trace。
4. runtime compatibility validator。
5. 必要时游戏内手测。
```

---

## 输出物

```text
1. 迁移批次清单。
2. DSL gap log。
3. 新增 DSL schema。
4. 迁移后的 authoring 内容。
5. 每批验收报告。
```

---

## 验收标准

```text
1. 每批真实 graph 内容可构建。
2. diagnostics 无未解释 error。
3. simulator 能跑关键 route。
4. publish compatibility 通过或给出明确阻断原因。
5. DSL gap 有闭环处理记录。
```

---

## 风险点

```text
1. 真实 graph 内容复杂度会暴露 runtime 旧语义。
2. 迁移时容易为了过关增加临时字段，需要回收。
3. 样例和真实内容要保持同一套 schema，不要分叉。
```

---

## 完成记录

### 迁移批次

本批选择“码头水鬼 / 水猴子到铁环流程”中的闭环内容：

```text
1. Narrative composition: dock_water_monkey_ring_flow
2. Main narrative graph: flow_dock_water_monkey
3. Embedded wrapper graph: npc_ringboy
4. Embedded wrapper graph: quest_return_ring
5. Dialogue graph: 滚铁环小孩
6. Dialogue graph: 码头看板
7. Quest: 支线-归还小孩铁环-归还铁环
8. Registry flags: archive_book_entry_erta_geo_iron_ring / 书籍_风物志_铁环标注 / 铁环小孩_已经获得铁环 / 码头水鬼真相已揭示
9. Signals: board_read_done / entered / pull_success / ring_taken / ring_returned / derived state:* broadcast signals
10. Related runtime refs: iron_hoop / erta_geo_iron_ring / npc_ringboy / 码头水鬼
```

### 新增 Authoring 内容

```text
authoring/narrative/flows/dock_water_monkey_ring_flow.yaml
authoring/dialogues/npc/ringboy.yaml
authoring/dialogues/scenario/dock_board.yaml
authoring/quests/side/return_ring.yaml
authoring/simulations/ringboy_snatch_route.json
authoring/tables/flags.csv
authoring/tables/signals.csv
authoring/tables/quests.csv
```

### DSL / Compiler 补齐

```text
1. compile_narrative 支持 compositionId，保证 composition runtime id 可与 main graph id 分离。
2. compile_narrative 支持 graphLabel，保留 mainGraph.label。
3. compile_narrative 索引 elements[].graph，embedded wrapper graph 进入 narrativeGraphs / narrativeStates / signals / actions / conditions / source map。
4. compile_narrative 索引 element meta.emits / meta.reads 和 dialogueBlackbox.refId。
5. compile_narrative 为 broadcastOnEnter derived signal 建 declaredAt / emitters / source map。
6. simulate_runtime 读取 elements[].graph，dialogue ownerState 和 signal cascade 可以命中 embedded wrapper graph。
7. runtime_compatibility_issues 检查 embedded wrapper graph 的 graph id、initial state、transition endpoint。
8. compile_dialogues 保留 meta 和显式 preconditions: []。
9. compile_quests 只在 authoring 显式声明 acceptActions 时输出该字段，避免真实迁移引入多余 runtime 字段。
10. embedded graph 中的 authoring-only action id 会用于 source map，但不会泄漏到 runtime preview JSON。
```

### 数据一致性对照

已对本批核心 runtime 对象做 legacy vs preview 对照：

```text
dialogue 滚铁环小孩 exact: true
dialogue 码头看板 exact: true
narrative dock_water_monkey_ring_flow exact: true
quest 支线-归还小孩铁环-归还铁环 exact: true
```

### Simulator 验收

用例：

```text
authoring/simulations/ringboy_snatch_route.json
```

覆盖链路：

```text
1. dialogue route 从 滚铁环小孩.root 进入。
2. ownerState 命中 npc_ringboy.after_event。
3. choice 选择 after_evt_choice -> snatch。
4. runActions 写入 iron_hoop、书籍_风物志_铁环标注、铁环小孩_已经获得铁环。
5. emit ring_taken。
6. npc_ringboy: after_event -> ring_taken。
7. broadcast state:npc_ringboy:ring_taken。
8. quest_return_ring: inactive -> active。
9. quest 支线-归还小孩铁环-归还铁环 被接受。
10. 所有 action / narrative / quest trace 都能定位到 authoring YAML；broadcastOnEnter 也有 source map。
```

结果：

```text
ok: true
blocked: []
final narrative:
  flow_dock_water_monkey: crate_minigame_done
  npc_ringboy: ring_taken
  quest_return_ring: active
final quest:
  支线-归还小孩铁环-归还铁环: Active
```

### Diagnostics / Compatibility

命令结果：

```text
npm run content:build: pass
npm run content:diagnostics-json: pass, warnings only
npm run content:simulate -- authoring/simulations/ringboy_snatch_route.json: pass
npm run content:runtime-compatibility: pass, ok true, issues []
npm run content:check: pass
```

剩余 warning 均为可解释项：

```text
1. 旧样例 old_zhou / bridge_find_source 的孤立 reader/writer 和未声明 narrativeState。
2. 本批真实迁移里的 archive / annotation / truth flag 目前只有一端引用，属于真实内容局部迁移导致的跨批边界。
3. ownership.legacyConflict 是预期保护：authoring preview 与 legacy runtime 有同 ID，publish 前会提示替换风险。
```

### 结论

```text
08 已完成。
本批不是 MVP 验证，也不是普通数据表迁移；它以真实 graph runtime 对象 exact-match 为标准迁移，同时补齐了 embedded wrapper graph 在 compiler、content index、source map、simulator、runtime compatibility 中的主入口语义。
```
