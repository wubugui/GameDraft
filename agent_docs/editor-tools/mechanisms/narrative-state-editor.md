---
id: narrative-state-editor
title: 叙事状态机编辑器(PySide 壳 + React Flow)
domain: editor-tools
type: mechanism
summary: 唯一非原生 PyQt 编辑器;三方校验中 Python 兜底必须是 TS 权威的子集、两步保存、dist 是独立产物(重建≠页面刷新)、落盘字节级幂等
status: active
authority:
  - tools/editor/editors/narrative_state_editor.py#WRAPPER_OWNER_CATALOG_KEYS
  - tools/narrative_editor_web/src/editor/appHelpers.ts#WRAPPER_OWNER_REGISTRY
  - src/core/narrativeGraphValidation.ts
triggers:
  paths: ["tools/editor/editors/narrative_state_editor.py", "tools/narrative_editor_web/*", "public/assets/data/narrative_graphs.json"]
  topics: [叙事状态机, narrative_graphs, QWebEngine, 两步保存, 校验兜底]
  tasks: [改叙事编辑器, 改叙事校验, 加 wrapper owner 类型]
verified_by:
  - tools/editor/tests/test_narrative_state_editor.py
last_governed: 2026-07-11
---

## 是什么(一句话)

主编辑器"叙事状态机"页 = PySide 外壳(QWebEngine + QWebChannel 桥)+ React Flow 网页应用 `tools/narrative_editor_web/`,编辑 `public/assets/data/narrative_graphs.json`。

## 权威源(读代码从哪进)

壳与桥:`tools/editor/editors/narrative_state_editor.py`(NarrativeEditorBridge);网页:`tools/narrative_editor_web/`;校验权威:`src/core/narrativeGraphValidation.ts`。

## 硬契约

1. **校验是三方,Python 兜底是故意的子集**:网页本地 TS 校验(权威·最深)→ Python 桥/保存路径粗校验(第二道防线,测试锁定必须在)。**红线:Python 兜底绝不能比 TS 更严**,否则拦住合法数据(踩过:`@owner`/`@scene` 相对 token 被 Python 误拦)。
2. **两步保存**:网页 Ctrl+S 只暂存进 ProjectModel + mark_dirty,**不落盘**;真写盘靠主编辑器"全部保存"。桥返回的协议串 `save blocked:` / `invalid ` 前缀被网页正则依赖,**不可翻译/改动**。
3. **dist 是独立构建产物**:壳加载的是打包好的 `dist/index.html`——改 `tools/narrative_editor_web/src/**` 必须 `npm run build:narrative-editor`;且 QWebEngine 不自动刷新,**重建≠页面刷新**(壳有两类 staleness 横幅提醒,dev server 模式除外)。
4. **落盘字节级幂等**:`_json_text(_normalize_file(json.load(disk))) == disk` 逐字节相等,改编辑器后必须保持。
5. **wrapper owner 双注册表对齐**:Python `WRAPPER_OWNER_CATALOG_KEYS` ↔ 网页 `WRAPPER_OWNER_REGISTRY`(+types/emptyCatalog),两边不同步 = 某 owner 类型选不到(踩过:web 漏 scene)。

## 已知坑

- 桥接原生 ConditionEditor 的往返对某些叶子(空 phase scenario、未登记 id)会静默丢——web 侧回写前有 `droppedConditionLeaves` 比对护栏,发现丢即放弃修改;动条件编辑链路别拆掉这道护栏。
- 归一化逻辑三语言重复(TS/Python/web)是架构固有,别试图"合并成一份";一致性靠各自字节幂等护栏 + parity 测试。
- **flow 主图 `ownerId` = 纯注释、零机制效力**(2026-07-13 拍板方案 B):运行时无 `ByOwner('flow')` 消费点、catalog 只判 ownerType、校验不读它;检查器对 flow 主图 Owner ID 呈只读 + 「仅注释·无机制效力」标注(TextField `readOnlyNote`)。**禁止**再让任何校验/候选机制消费 flow ownerId——曾从码头孤例(ownerId 恰为 scenario id)误推 `flow→scenarioIds` 候选致全线误报;新增 owner 消费逻辑前先看本条。**wrapper 图的 owner 不受影响**,仍是真引用(注册表映射 + 校验 + 跳转)。
- **wrapper/scenario 子图元素的 `meta.emits/reads` 不再手编**(2026-07-13 拍板):检查器「高级」两栏改为从子图内容自动派生的只读展示(`deriveGraphInterface`:状态动作 emit + broadcastOnEnter 派生 = 发出;迁移 signal = 监听;条件叶子 = 读取,口径对齐 [emitted-signal-catalog](emitted-signal-catalog.md));遗留手填显示「旧登记」可一键清空。黑盒元素保留登记语义(先接线后写对话),但候选从「全目录平铺」改为「已选 chip + 搜索弹窗」(对齐 [下拉vs弹窗拍板](decisions/2026-07-11-dropdown-vs-popup-selector.md)),emits 候选滤掉 `state:` 派生信号、reads 候选 = 图 id。

## 怎么验证

`pytest tools/editor/tests/test_narrative_state_editor.py`;`npx vitest run tools/narrative_editor_web`;`npx vitest run src/core`;改网页后 `npm run build:narrative-editor` + `npm run typecheck:narrative-editor`。纯 web 调试模式已可加载真实数据(vite dev-only `/assets` 只读中间件),不必经 PySide 壳即可复现浏览器行为。
