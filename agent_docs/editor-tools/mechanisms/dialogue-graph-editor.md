---
id: dialogue-graph-editor
title: 图对话编辑器
domain: editor-tools
type: mechanism
summary: 独立包内嵌主编辑器的图对话编辑;分层架构 + 表单形状保真回写 + 语义零变化时原样字节回写;往返探针是改 inspector 的必跑门
status: active
authority:
  - tools/dialogue_graph_editor/graph_document_model.py
  - tools/dialogue_graph_editor/node_inspector.py
  - tools/dialogue_graph_editor/editor_widget.py
triggers:
  paths: ["tools/dialogue_graph_editor/*", "tools/editor/editors/dialogue_graph_editor_tab.py", "public/assets/dialogues/graphs/*"]
  topics: [图对话, 对话编辑器, node_inspector, 往返探针]
  tasks: [改图对话编辑器, 加对话节点类型或字段]
verified_by:
  - tools/dialogue_graph_editor/tests/test_inspector_roundtrip.py
  - tools/dialogue_graph_editor/tests/test_latent_roundtrip_fidelity.py
  - tools/dialogue_graph_editor/tests/test_open_clean_and_save_fidelity.py
last_governed: 2026-07-11
---

## 是什么(一句话)

编辑 `public/assets/dialogues/graphs/*.json`(唯一权威对话源——`.ink` 已于 2026-06-30 用户拍板全部废弃,别当真值)的图编辑器:独立包 `tools/dialogue_graph_editor/`,主编辑器页只是薄壳 tab。

## 权威源(读代码从哪进)

分层:`graph_document_model.py`(单一真相源+信号+dirty)/ `dialogue_topology.py`(声明式节点出口 slot 表,加节点出口改这里)/ `flow_oden_controller.py`(画布投影)/ `node_inspector.py`(单节点表单)/ `editor_widget.py`(宿主胶水)。画布坐标存独立 `editor_data/dialogue_flow_layout.json`(`flow_layout_store.py`),不污染图 JSON、不标脏。

## 硬契约

1. **表单形状保真回写**:磁盘上同语义有多种形状(裸 next vs conditions、缺省 vs 空列表、有无 op/status 键)——加载时记 `_had_*`/`orig_present` 基线,回写按原形状,不注入默认键、不做"顺手规范化"(conditions→condition 重排会改 30+ 文件)。
2. **表单表达不了的形状走只读 raw-passthrough**(原样保留,编辑改走结构化模式),不是"当空值加载再写回"。
3. **语义零变化 → 原样字节回写**:磁盘图是外部工具按不一致风格预格式化的,无序列化器能复现;保存时与 `_loaded_disk_bytes` 基线比对,内容语义没变就原字节写回;保存前还有外部改动覆盖确认(拦 last-writer-wins)。
4. **画布增量更新**:纯视觉编辑原地更新;只有连线目标/端口签名变化才整图重建;可达性诊断色只随拓扑变。
5. 自动布局用 grandalf(所有输入按 id 排序保跨进程确定性);手搓 Sugiyama 变体已弃,别重写。

## 已知坑

- 构造 NodeInspector 必须传 `project_model_getter`,否则 ActionEditor 的 id 选择器回填不了,探针误报"丢参数"。
- error 强制保存弹窗保留默认 No(不硬拦)——用户工作流拍板(2026-07-11),别"顺手"改成阻断。
- 头像/说话人语义见 runtime 域对应机制卡(对话头像系统)。

## 怎么验证

- **改 node_inspector 后必跑** `test_inspector_roundtrip.py`(逐真实图逐节点 set_node→get_node 深等);真实数据覆盖不到的形状靠合成 fixture `test_latent_roundtrip_fidelity.py`;打开即脏/字节回写由 `test_open_clean_and_save_fidelity.py` 锁定。
