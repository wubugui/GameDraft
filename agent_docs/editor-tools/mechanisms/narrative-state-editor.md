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
  - tools/narrative_editor_web/src/hooks/useEditorHistory.test.ts
  - tools/narrative_editor_web/src/canvas/edgeRouting.test.ts
last_governed: 2026-08-05
---

## 是什么(一句话)

主编辑器"叙事状态机"页 = PySide 外壳(QWebEngine + QWebChannel 桥)+ React Flow 网页应用 `tools/narrative_editor_web/`,编辑 `public/assets/data/narrative_graphs.json`。

## 权威源(读代码从哪进)

壳与桥 `tools/editor/editors/narrative_state_editor.py`;网页 `tools/narrative_editor_web/`;校验权威 `src/core/narrativeGraphValidation.ts`。

## 硬契约

1. **校验三方,Python 兜底是故意的子集**:网页 TS 校验最深最权威,Python 桥/保存路径只做粗校验。**红线:兜底绝不能比 TS 更严**(更严 = 拦住合法数据;踩过相对 token 误拦、`plane` 叶漏在形状判定外致合法条件必被拦保存)。**新增条件叶子或新形状必须同步补 Python 侧判定。**
2. **两侧 normalize 都不代写数据**:归一化只做格式,禁止替作者补派生字段(曾在桥路径代写 broadcastOnEnter,连带把对应校验变成死代码,已整段删除,别重新引入)。
3. **两步保存**:网页 Ctrl+S 只暂存进 ProjectModel + mark_dirty、**不落盘**,真写盘靠主编辑器"全部保存";桥返回的协议串前缀被网页正则依赖,**不可翻译/改动**。
4. **dist 是独立构建产物**:改网页源码必须重新 build,且 QWebEngine 不自动刷新——**重建≠页面刷新**(壳有 staleness 横幅,dev server 模式除外)。
5. **落盘字节级幂等**:`_json_text(_normalize_file(json.load(disk))) == disk` 逐字节相等,改编辑器后必须保持。
6. **wrapper owner 双注册表两侧对齐**:不同步 = 某 owner 类型选不到(踩过 web 漏 scene)。
7. **网页文档是加载期快照,进模型前必须过 `merge_host_only_author_signals`**:React 只在挂载时取一次数据,而原生「信号管理器」直接改模型,原样回写会抹掉加载后新注册的作者信号。判据是**加载基线**——基线里没有的宿主行才补回,基线里有而网页文档没有 = 网页显式删除、尊重不复活;**四条进模型的路(saveData / applySignalRefactor / stampTemplate / 壳 flush)都要打补丁**,暂存成功后推进基线。

8. **画布连线几何统一走 `canvas/edgeRouting.ts`,四向端口有两条不可颠倒的约束**(2026-08-06 加):
   状态/元素/锚点节点每侧都叠 target+source 两个 handle,**source 必须渲染在 target 之后**——
   拖线时 React Flow 按 `elementFromPoint` 取最上层那个,而从 target 口起拖会把「拖出的那一端
   认成 target」(system `source: isTarget ? handleNodeId : fromNodeId`),方向与手势相反;
   且**必须同时开 `ConnectionMode.Loose`**,否则落点命中上层 source 口会判无效、根本连不上。
   另:无 handle id 的边取 `bounds[0]`,故 source 数组首项固定 'r'、target 首项固定 'l';
   **非四向节点(subgraphGroup / editorGroupFrame / transitionAnchor,端口被 CSS 钉在 top:50%)
   绝不能写 handle id**,写了查不到端口(error008)整条边不渲染。触发点吸附与边渲染共用同一套
   路由函数,改任一侧都要两边一起对(护栏 `canvas/edgeRouting.test.ts`)。
   分组折叠会**改接端点到分组框、并整条隐藏组内边**,所以触发点要在 display 层按折叠后的边
   再对一次(`alignTransitionAnchorsToDisplayEdges`),否则飘在半空 / 留下没有边的孤点;
   且**框类节点的尺寸必须读 `style` 而非 `measured`**——折叠瞬间 style 已是紧凑尺寸、
   measured 还是展开时的旧值,读错就差出几十像素。

9. **重构引用面登记表漏一种形状 = 预览少算 + 级联静默漏改 + 拖到校验门才炸**:改名预览敢报
   "0 处引用,可安全操作"。表键必须解析到 `ProjectModel` 的真实属性——`getattr` 兜 `None`
   会静默跳过整张表,这是该类漏洞的固定形状,列进镜像 parity 门的固定检查项。

## 已知坑

- 同一事件连打两次 `updateData` = 第二次赢、第一次被静默丢弃(根因:绕过持有串行基线的撤销核,直接读渲染期 data 再 setData);直接 `setDataInternal` 的路径(初次加载、adopt 重构结果)必须同 tick 追平基线。
- 目录里"看得见的信号"≠"注册过的信号":只被监听/黑盒声明的信号会被补成影子条目,长得和真注册行一样,判据只有 `entry.registered`。
- 桥接原生 ConditionEditor 的往返对某些叶子(空 phase scenario、未登记 id)会静默丢:web 侧回写前有丢叶比对护栏,发现丢即放弃修改——动条件链路别拆掉它。
- 归一化逻辑三语言重复(TS/Python/web)是架构固有,别试图合并;一致性靠各自字节幂等护栏 + parity 测试。
- **flow 主图 `ownerId` = 纯注释、零机制效力**(2026-07-13 拍板):禁止任何校验/候选机制消费它(曾据孤例误推候选致全线误报);**wrapper 图的 owner 不受影响**,仍是真引用。
- **wrapper/scenario 子图元素的 `meta.emits/reads` 不再手编**(2026-07-13 拍板):改为从子图内容自动派生的只读展示(口径对齐 [emitted-signal-catalog](emitted-signal-catalog.md));黑盒元素保留登记语义,候选走搜索弹窗(对齐 [下拉vs弹窗拍板](../decisions/2026-07-11-dropdown-vs-popup-selector.md))。

## 怎么验证

`pytest tools/editor/tests/test_narrative_state_editor.py`;`npx vitest run tools/narrative_editor_web`;`npx vitest run src/core`;改网页后 `npm run build:narrative-editor` + `npm run typecheck:narrative-editor`。纯 web 调试模式可直接加载真实数据,不必经 PySide 壳复现浏览器行为。
