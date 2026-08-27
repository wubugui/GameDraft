---
target: dialogue-graph-editor
date: 2026-08-27
session: contextState 归属闸门降级 + graphId 选择器换弹窗
---

现象: 「contextState 不能读 npc/hotspot wrapper」被实现成 error，但它**拦不住任何东西且比 TS 权威更严**——同一个 `getActiveState` 读取换成 switch 的 narrative 条件叶子完全免检（`condition_expr_tree._narrative_graph_entries` 把所有 wrapperGraph 都列出来，全项目无 allow-list），运行时 `GraphDialogueManager.evalContextState` 也不查归属；且该布尔把「图不存在」和「读的是实体 wrapper」压成同一个 False，于是 `后巷_棺材铺交互` 的悬垂 `后巷_街边店铺` 被报成 wrapper 措辞，真毛病被盖住近一年。附带：`list_context_readable_graphs` 连自己放行的 `scene` 都没列进候选（校验放行、选择器不列），而那是个 40+ 候选的**可编辑长下拉**——2026-07-11「引用一律弹窗」拍板下的现存违规。

证据: 实测 127 张对话图里 narrative 读取 97 处走 switch 条件叶子、仅 3 处走 contextState，其中 `寻狗_读人_儿子/婆子` 两处已在用 switch 读 npc wrapper 且零告警；validate-data 基线 35 error → 改后 34（只掉 `后巷_棺材铺交互` 那条）。改动落在 `narrative_catalog.classify_context_graph`（三分：ok/crossEntity/missing）+ `graph_document._validate_owner_context_state_nodes` + `node_inspector._build_context_state`（换 `ReferencePickerField`）。

建议: 卡里补一条通则——**给某个节点类型单独加 error 之前，先查同一语义有没有别的免检入口**；只堵一个入口的「铁律」等于把作者推去用另一个节点，还顺带违反「Python 兜底不得比 TS 权威更严」。另：`dialogue-graph-editor` 界面硬契约建议把「引用字段禁长下拉」列进 §16 那种逐类型点名的 parity 检查，否则现存违规只能靠人肉发现。
