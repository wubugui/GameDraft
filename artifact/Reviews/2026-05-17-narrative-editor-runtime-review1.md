**问题报告**

我按“生产级作者工具 + 运行时模块”标准审查了一遍。结论很明确：现在不是单纯 UI 没打磨，而是还有几处语义层、校验层、运行时层没有真正闭环。

1. **严重：跨图 transition 的运行语义不严谨**
   [NarrativeStateManager.ts](d:/GameDraftNew/GameDraft/src/core/NarrativeStateManager.ts:386) 的跨图 transition 只把目标图切到 `to.stateId`，但源图的 `from` state 不退出，不触发源 state 的 `onExitActions` / `stateExited`。  
   这会导致“看起来是一条真实迁移边”，实际运行却像“远程设置目标图状态”。如果这是设计，就不该叫普通 transition；如果是普通 transition，现在语义是错的。

2. **严重：scenario 的局部性只在编辑器校验，不在运行时保证**
   `setNarrativeState` 可以直接设置任意 state，包括 scenario 内部非边界 state：[NarrativeStateManager.ts](d:/GameDraftNew/GameDraft/src/core/NarrativeStateManager.ts:238)。  
   `applyStateCommand` 同样直接写入：[NarrativeStateManager.ts](d:/GameDraftNew/GameDraft/src/core/NarrativeStateManager.ts:376)。  
   这意味着外部 JS、action、坏数据都能绕过 entry/exit 规则。scenario “防止状态发散”的核心意图没有被 runtime 兜住。

3. **严重：Graph 重命名不会同步引用**
   Graph Inspector 直接改 `g.id`：[NarrativeEditorApp.tsx](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/NarrativeEditorApp.tsx:872)。  
   但不会同步 `{ graphId, stateId }` endpoint、`stateEntered:oldGraph:state` 信号、`setNarrativeState.graphId`、condition、reads/emits 等引用。  
   State rename 有同步逻辑，Graph rename 没有，这是明显的不完整实现。

4. **严重：Python bridge 的 `saveData` 自身不做校验**
   [narrative_state_editor.py](d:/GameDraftNew/GameDraft/tools/editor/editors/narrative_state_editor.py:83) 直接解析并写文件。  
   前端保存前会校验，但 bridge 是边界层，不能相信客户端。任何前端 bug、直接 WebChannel 调用、旧页面调用都可能把非法 narrative graph 写进去。

5. **严重：校验逻辑 TS/Python 双份实现，已经具备漂移风险**
   TS 校验在 [editorModel.ts](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/editorModel.ts:436)，Python 校验在 [narrative_state_editor.py](d:/GameDraftNew/GameDraft/tools/editor/editors/narrative_state_editor.py:415)。  
   两边重复维护 ownerType、transition endpoint、scenario boundary、action/condition 形状。Python 还额外校验外部 StateCommand，TS 不知道完整上下文。  
   对作者工具来说，保存规则必须单一来源，否则迟早出现“前端说能存，后端/运行时炸”的状态。

6. **严重：高级 JSON Apply 可以把非法结构直接塞进编辑器状态**
   [NarrativeEditorApp.tsx](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/NarrativeEditorApp.tsx:490) 的 `applySelectedJson` 直接替换 graph/state/transition/element 内容。  
   它没有先跑同一套 validate/normalize，也没有做引用同步。保存也许会挡住一部分，但编辑器状态已经能被搞坏，后续 UI 推导就会继续基于坏状态运行。

7. **中高：新建 transition 使用硬编码 TODO signal，且能通过校验**
   [editorModel.ts](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/editorModel.ts:169) 默认生成 `external:system:TODO:signal`。  
   校验只检查 signal 非空，所以 TODO 可以被合法保存。这是典型临时实现残留。

8. **中高：外部接线/原 projection 仍然是启发式推导，不是稳定架构**
   Python 通过扫描 action/condition 猜测关系，比如 `_iter_action_signal_sources`、`_source_node_for_action`、`_source_node_for_condition`：[narrative_state_editor.py](d:/GameDraftNew/GameDraft/tools/editor/editors/narrative_state_editor.py:819)。  
   这不是一个清晰的 authoring contract，而是从旧数据里“猜线”。它可以作为诊断层，但不应该被做成主画布上和真实状态同级的核心结构。

9. **中高：外部接线节点 ID 仍然不是完整语义 ID**
   `_graph_node_index` 生成类似 `state:{sid}`、`subgraph:{elementId}:state:{sid}`：[narrative_state_editor.py](d:/GameDraftNew/GameDraft/tools/editor/editors/narrative_state_editor.py:740)。  
   transition anchor 是 `transition-anchor:{graphId}:{transitionId}`：[narrative_state_editor.py](d:/GameDraftNew/GameDraft/tools/editor/editors/narrative_state_editor.py:993)。  
   这比之前好，但仍然偏 UI 字符串拼接，不是结构化 endpoint。后续选择、定位、解释、去重都会脆。

10. **中：runtime 遇到重复 graph id 会静默覆盖**
   [NarrativeStateManager.ts](d:/GameDraftNew/GameDraft/src/core/NarrativeStateManager.ts:174) 直接 `this.graphs.set(graph.id, graph)`。  
   校验能挡一部分，但 runtime 边界不该静默覆盖。否则 owner index、activeStates、debug snapshot 会进入不可解释状态。

11. **中：本地模拟和真实运行时不等价**
   `simulateSignalImpact` 在 [editorModel.ts](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/editorModel.ts:359) 只做简化 condition 计算，不执行 actions，也不覆盖完整 condition 类型。  
   结果是 Runtime Preview 可能告诉作者“会迁移”，真实 runtime 不迁移，或反过来。

12. **中：信号 key 用冒号拼接，sourceId 含冒号会解析错**
   runtime 生成 key：[NarrativeStateManager.ts](d:/GameDraftNew/GameDraft/src/core/NarrativeStateManager.ts:145)。  
   editor 解析 key：[editorModel.ts](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/editorModel.ts:351)。  
   `signal` 尾部可以 join 回来，但 `sourceId` 不能含冒号。scene/entity/ref 这类 id 很容易天然带冒号，这个格式不安全。

13. **中：Action 编辑还有死代码/旧路径残留**
   `ActionListField` 现在前面走 Python/Qt ActionEditor，但后面还残留手写 action type/param UI 代码：[NarrativeEditorApp.tsx](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/NarrativeEditorApp.tsx:1811)。  
   这说明“1:1 复用其他 action 编辑入口”的改造没有收干净，后续维护者很容易误改旧路径。

14. **中：切换 composition 时展开状态可能串场**
   新建 composition 会清 `expandedElementIds`，但从左侧切换已有 composition 只清 selected：[NarrativeEditorApp.tsx](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/NarrativeEditorApp.tsx:618)。  
   如果不同 composition 有相同 element id，可能错误展开别的子图。这个和你之前说“新建 composition 状态混乱”属于同一类状态隔离问题。

15. **中低：React Flow 的 nodes/edges 同时由模型推导和局部 setEdges 维护**
   模型变化会重算 nodes/edges：[NarrativeEditorApp.tsx](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/NarrativeEditorApp.tsx:161)。  
   但 `onConnect` 又手动 `setEdges(addEdge(...))`：[NarrativeEditorApp.tsx](d:/GameDraftNew/GameDraft/tools/narrative_editor_web/src/NarrativeEditorApp.tsx:361)。  
   这是双状态源，容易出现瞬间重复边、脏边、选择错乱。

**架构判断**

现在最大的问题不是“功能少”，而是三层边界没完全定死：

- runtime 没有强制 scenario 局部性。
- editor 的结构化模型、JSON 高级编辑、Python bridge 校验不是同一个权威路径。
- 外部接线/原 projection 还像兼容旧系统的诊断层，却被塞进主画布语义里。

我建议下一步优先不是继续加 UI，而是先收敛这三件事：runtime 强约束、单一校验/normalize 入口、外部接线降级为边选中后的解释层。测试也应围绕这三点补，而不是只测“能 build”。  以上是另外一份审查报告，