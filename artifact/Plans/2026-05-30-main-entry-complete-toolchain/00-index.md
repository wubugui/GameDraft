# 主入口完整工具链小计划索引

## 目标

把主入口完整工具链拆成可以单独执行、单独验收、单独排期的小计划。

每个小计划都保持以下结构：

```text
1. 目标
2. 范围
3. 前置依赖
4. 任务清单
5. 输出物
6. 验收标准
7. 风险点
```

---

## 小计划列表

```text
01-DONE-simulator-complete-trace-plan.md
  Simulator 完整模拟和 trace 闭环。已完成。

02-DONE-action-condition-schema-validation-plan.md
  Action / Condition 参数级 schema 校验。已完成。

03-DONE-lsp-deepening-plan.md
  LSP 深度能力补全。已完成。
  实现内容：document_overrides 在内存诊断、精确上下文补全（action type/params/stateId/scenarioId）、
  code action 改进（指向正确文件、action schema 快速访问）。

04-DONE-webview-spatial-pickers-plan.md
  VS Code Webview 空间字段 picker。已完成。
  实现内容：src/spatial/ 纯函数层（fieldResolver/yamlBlock/sceneGeometry）；
  pickSpatialField 自动识别字段类型分发；polygon 编辑器（写回 scene JSON）；
  patrol route 编辑器（写回 scene JSON，剔除基点）；spawn/zone/entity/scene ID 选择器
  （QuickPick+写回 YAML）；统一 WriteBack 协议（版本冲突检测+写后刷新诊断）；
  34 个纯函数单测 + SMOKE.md 手测脚本。

05-DONE-webview-graph-reference-views-plan.md
  Graph preview / reference view Webview。已完成。
  实现内容：通用只读 Reference Webview；signal flow、flag read/write、quest dependency、
  dialogue route explain、runtime trace timeline 五类视图；Open Source 跳源协议；
  GRAPH_REFERENCE_VIEWS_SMOKE.md 手测脚本。

06-DONE-content-index-deepening-plan.md
  Content index 覆盖面和风险关系深化。已完成。
  实现内容：items/rules/archive/audio 桶；scan_action_refs 扩展（setNarrativeState、
  giveItem/Rule/ArchiveEntry、playBgm/Sfx、startScenario 系列）；owner boundary 字段进
  narrativeGraphs/narrativeStates 索引；validate_cross_owner_risks；validate_duplicate_runtime_ids。

07-DONE-publish-ownership-finalization-plan.md
  Publish / ownership 主入口规则最终化。已完成。
  实现内容：ownership_status / collect_generated_output_paths（T1）；
  validate_mixed_ownership 检测 pipeline 与 legacy runtime ID 碰撞（T2）；
  runtime_compatibility_issues 扩展：flag valueType、quest type、narrative schemaVersion、
  ownerType missing、dialogue schemaVersion（T3）；LSP didOpen + hover 生成文件防手改警告（T4）；
  build 输出 ownership_manifest.json（T5）。

08-DONE-real-content-dsl-migration-plan.md
  真实 Graph DSL 迁移和表达缺口补齐。已完成。
  实现内容：迁移 dock_water_monkey_ring_flow / 滚铁环小孩 / 码头看板 /
  支线-归还小孩铁环-归还铁环；legacy vs preview 四类对象 exact-match；
  embedded wrapper graph 进入 compiler/index/source map/simulator/runtime compatibility；
  ringboy_snatch_route 模拟通过；普通 runtime 数据不做全量表迁移。

09-DONE-ci-workspace-command-chain-plan.md
  CI / workspace 一键检查链。已完成。
```

---

## 建议执行顺序

推荐先做运行语义，再做编辑体验和发布收口：

```text
1. 01 DONE Simulator 完整模拟
2. 02 DONE Action / Condition schema 校验
3. 06 DONE Content index 深化
4. 03 DONE LSP 深度化
5. 04 DONE Webview 空间 picker
6. 05 DONE Graph reference views
7. 07 DONE Publish / ownership 最终化
8. 08 DONE 真实 Graph DSL 迁移
9. 09 DONE CI / workspace 一键链路
```

说明：

```text
1. 01 和 02 提供语义和校验基座。
2. 06 为 LSP、Webview 和 publish 提供统一索引。
3. 08 应该贯穿执行，但可以在工具链有基础能力后集中推进。
4. 09 最后收口，但每个小计划完成后都应补对应 smoke 或测试入口。
```
