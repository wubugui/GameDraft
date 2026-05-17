# 2026-05-17 Narrative Editor & Runtime Review（最终合并版）

## 合并说明

本报告由当日两份独立审查（`2026-05-17-narrative-editor-runtime-review.md`、`2026-05-17-narrative-editor-runtime-review1.md`）合并而成。所有结论已经通过只读子代理对照仓库当前代码逐条复核，标注结论的成立度（成立 / 部分成立 / 不成立）。重叠条目合并表述，互补条目按系统层次重新组织。

## 审查范围

- 运行时：`src/core/NarrativeStateManager.ts`、`src/systems/GraphDialogueManager.ts`、`src/systems/DocumentRevealManager.ts`、`src/systems/graphDialogue/evaluateGraphCondition.ts`、`src/Game.ts`
- Web 叙事编辑器：`tools/narrative_editor_web/src/editorModel.ts`、`tools/narrative_editor_web/src/bridge.ts`、`tools/narrative_editor_web/src/NarrativeEditorApp.tsx`
- 主编辑器与桥接：`tools/editor/editors/narrative_state_editor.py`、`tools/editor/main_window.py`、`tools/editor/project_model.py`

## 总体判断

叙事状态机已能跑通 demo，但尚未达到「严谨生产级模块 + 作者工具」的标准。**核心问题不在 UI，而是三层契约还没收敛**：

- **运行时**：跨图边语义、scenario 局部性、生命周期顺序、队列 promise 语义、初始进入态等存在多处不严谨。
- **保存链路**：Web → QWebChannel → PySide → ProjectModel 这条链上的 dirty、flush、confirm_close、bridge 校验全部断点。
- **校验**：Web TS、`tools/editor` Python、Game runtime 各自维护一份近似逻辑，错误码已开始漂移，且 bridge 边界完全信任前端。

副作用是作者在编辑器中看到的结果、保存前校验结果、真实游戏运行结果三者可能不一致。规模继续扩大时，问题会从单点 bug 上升为「作者无法信任工具」。

## 高优先级问题

### H1. 运行时：图对话 / 文档揭示无法读取 narrative 条件【成立】

`evaluateGraphCondition.ts` 的 narrative 叶子依赖 `ctx.narrativeState?.isStateActive(...)` / `ctx.narrativeState?.getActiveState(...)`（约 148-151、247-251 行），而：

- `src/systems/GraphDialogueManager.ts` 的 `conditionCtx()`（约 179-186 行）只注入 `flagStore` / `questManager` / `scenarioState` / `resolveConditionLiteral`，**未注入 `narrativeState`**。
- `src/systems/DocumentRevealManager.ts` 的 `ctx()`（约 94-103 行）同样缺失。
- 而 `src/Game.ts` 中已存在统一的 `mkCondCtx`（约 639-645 行）并正确注入 `narrativeState`，但这两个模块没有用它。

影响：

- 图对话 `preconditions`、`choice.requireCondition`、`switch` 中所有 narrative 条件恒为 false。
- `document_reveals.json` 中所有 narrative 条件恒为 false。

修复建议：

- 强制所有模块通过 `Game.mkCondCtx` 获取上下文，禁止业务模块手搓 `ConditionEvalContext`。
- 增加单测覆盖：图对话 preconditions / choice / switch / document reveal 各自引用 narrative state 的成立路径。

---

### H2. 运行时：跨图 transition 不退出源 state【成立】

`NarrativeStateManager.applyTransition()`（约 406-407 行）在 `to.graphId !== from.graphId` 时**只对目标图调用 `enterState`**，源图 `activeStates` 不更新，源 state 的 `onExitActions` 与 `stateExited` 生命周期不触发。

影响：

- 表面是一条普通迁移边，实际语义等同于「远程设置目标图状态」，与作者预期不符。
- 任何依赖源状态 `onExit` 副作用、`stateExited` 监听的下游模块均会失效。

修复建议：

- 明确跨图 transition 是「迁移边」还是「远程 set」。
- 如果是迁移边，必须在切目标图前对源 state 走完整 exit 流程。
- 如果是远程 set，应在 schema 上重命名为 `setRemote` 之类的命令，避免与普通 transition 同型混用。

---

### H3. 运行时：`setNarrativeState` / `applyStateCommand` 绕过 scenario 边界【成立】

`NarrativeStateManager.setNarrativeState()`（约 238-242 行）只是 `enqueue({ kind: 'setState' })`；`applyStateCommand()`（约 376-383 行）在校验图和 state 存在后直接调 `enterState`，**没有 entry/exit/boundary 检查**。

而 `editorModel.ts` 中的 `validateCrossGraphBoundary` / scenario 边界规则（约 561-584 行）只作用于**编辑器保存前校验**，不是运行时强约束。

影响：

- 外部 JS、action、坏数据可以直接把 scenario 切到非边界 state，绕过编辑器约定的 entry/exit 规则。
- scenario「防止状态发散」的核心意图未由 runtime 兜住，工具校验形同建议。

修复建议：

- 把 scenario 边界判断下沉到 `applyStateCommand`，非法目标返回错误并写入运行时 snapshot。
- 编辑器侧的 `validateCrossGraphBoundary` 应与 runtime 引用同一份规则，避免漂移。

---

### H4. 运行时：`stateExited` 同图离开语义错位【成立】

`NarrativeStateManager.enterState()` 先 `enqueueLifecycle('stateExited', ...)`（约 419 行），随后立刻 `activeStates.set` 切到目标状态（约 421-422 行）。`processTrigger()` 匹配 transition 时只看当前 `active`（约 343-348 行）。

影响：

- 监听 `stateExited:graph:oldState` 且从 `oldState` 出发的同图 transition 永远不会命中（队列处理该 lifecycle 时 `active` 已经是新状态）。
- 编辑器允许把 `stateExited` 当成普通信号用，并参与重命名 / 投影，作者预期与运行时行为不一致。

修复建议：

- 明确 lifecycle signal 是「跨图通知」还是「本图离开钩子」。
- 如果支持本图离开边，必须在 `activeStates` 切换前匹配并处理 lifecycle transition，或建立独立匹配路径。
- 增加同图 / 跨图 `stateExited` 的回归用例。

---

### H5. 运行时：drain 期间入队的 trigger 返回错误的已完成 Promise【成立】

`NarrativeStateManager.enqueue()` 在 `draining` 为真时执行 `this.queue.push(trigger); return Promise.resolve();`（约 303-307 行）。

影响：

- `await emitNarrativeSignal()` / `await setNarrativeState()` 在生命周期 action 内被调用时，会立刻得到 fulfilled Promise，但触发实际尚未应用。
- 状态机内部的递归触发顺序、runtime snapshot、依赖叙事信号的链式 action 会出现竞态。

修复建议：

- draining 状态下应返回当前 `drainPromise`，或为每个 queued trigger 单独建一个完成 deferred。
- 增加 action 内部嵌套 emit / setState 的顺序断言测试。

---

### H6. 运行时：初始状态 `onEnterActions` 不执行，也不发 `stateEntered`【成立】

`registerGraphs()`（约 174-188 行）只做 `activeStates.set(graph.id, graph.initialState)` 和 flag 投影，**没有调用 `enterState`、没有触发 `stateEntered`、也没有跑 `onEnterActions`**。

影响：

- 编辑器允许给初始状态配 `onEnterActions`，作者认为它会执行，运行时却完全忽略。
- 第一帧的全局 flag、外部信号、UI 提示等副作用全部丢失。

修复建议：

- 明确 initial 进入态是否需要执行生命周期。
- 如果执行：注意读档反复触发问题，需要由 save 系统配合标记「已执行过」。
- 如果不执行：编辑器侧应禁止或警告 `initialState.onEnterActions` 的存在。

---

### H7. 运行时：重复 graph id 静默覆盖【成立】

`registerGraphs()` 内 `this.graphs.set(graph.id, graph)`（约 184 行），无重复检测，后者覆盖前者无任何告警。

影响：

- 同批次 / 跨数据源重复 id 会让 owner index、`activeStates`、debug snapshot 进入不可解释状态。
- 编辑器校验只覆盖一份数据源，跨文件冲突无法被发现。

修复建议：

- runtime 侧遇重复 id 必须抛错（或至少结构化告警 + 拒绝注册第二份）。
- 编辑器侧 normalize 阶段扫描全工程 graph id 唯一性。

---

### H8. 运行时：`loadFromAsset` 异常降级为空图【部分成立】

`NarrativeStateManager.loadFromAsset()`（约 164-171 行）在 `catch` 中 `console.warn(...)` 后调用 `this.registerGraphs([])`。

部分成立：确有 `console.warn`，并非「完全静默」，但效果上仍是「坏数据 → 整套叙事系统不响应」，对开发者排错极不友好。

影响：

- 坏 JSON / 坏 schema / 资源路径错误对玩家表现成「叙事系统没反应」。
- production 环境下没有结构化错误回路。

修复建议：

- dev 模式下 hard fail，或把异常直接抛到 DebugPanel。
- production 下记录结构化错误，暴露到运行时 snapshot 与玩家上报通道。

---

### H9. 运行时：信号 key 用冒号拼接，sourceId 含冒号会解析错【成立】

`NarrativeStateManager.externalKey` 生成 `external:${sourceType}:${sourceId}:${signal}`（约 145-146 行），`editorModel.ts` 的 `parseExternalSignalKey` 用 `key.split(':')` 解析，`sourceId` 取 `parts[2]`，`signal` 用 `parts.slice(3).join(':')`（约 351-356 行）。

影响：

- `signal` 末尾允许带冒号（被 join 还原），但 `sourceId` 含冒号时无法解析回原值。
- scene / entity / asset ref 类 id 天然就可能带冒号，未来扩展非常脆弱。

修复建议：

- 信号 key 改为结构化对象（不要在传输层依赖字符串拼接），或对各字段强制 URL-safe 编码。
- 编辑器与 runtime 共用同一份 key 编解码工具。

---

### H10. 工具链：主编辑器 Save All 链路断裂【成立】

- `tools/editor/editors/narrative_state_editor.py:269` 的 `flush_to_model()` 直接 `return True`。
- 同文件 `confirm_close()` 也直接 `return True`。
- `tools/editor/main_window.py:629-670` 的 `_flush_editors_to_model` / `_save_all` 完全依赖各页签的 `flush_to_model`。

影响：

- 用户在 Web 画布中编辑后，如果没有点 Web 内部 Save，主编辑器 Save All **不会把 React state 回写 `ProjectModel`**。
- 切换项目 / 关闭项目 / 未保存提示**全部缺失**。
- 这破坏了主编辑器统一保存模型，是工具链级严重问题。

修复建议：

- Web 侧维护 dirty 状态。
- QWebChannel 暴露 `getCurrentData` / `isDirty` / `flushToModel`。
- `NarrativeStateEditor.flush_to_model()` 必须主动同步拉取 Web 当前数据并写 `ProjectModel`。
- `confirm_close()` 必须根据 Web dirty 状态走 保存 / 丢弃 / 取消三选一。

---

### H11. 工具链：PySide bridge `saveData` 不在边界做校验【成立】

`tools/editor/editors/narrative_state_editor.py:83-93` 的 `saveData` 只做 `json.loads` 与「根对象为 dict」检查，随后 `_normalize_file` 直接写入 `narrative_graphs` 并 `mark_dirty`。校验函数 `validate_narrative_graphs` 被放在独立的 `validateData` slot（约 108-121 行），与 `saveData` 完全分离。

影响：

- 前端 bug、直接 WebChannel 调用、旧版 Web 页面缓存调用等任何路径，都可以把非法 narrative graph 写进项目。
- 「前端能存，后端不校验」是典型的边界层信任错误。

修复建议：

- bridge `saveData` 内部必须先调用 `validate_narrative_graphs`，error 级别直接拒绝。
- 与下面 H12 配合，校验规则单一来源。

---

### H12. 工具链：TS / Python / runtime 三份校验，无单一入口【成立】

当前实测：

- TS Web：`tools/narrative_editor_web/src/editorModel.ts` 内 `validateNarrativeData` / `validateActions`（约 611-621）/ `validateConditions`（约 624-643）/ `isConditionShape` 一套。
- Python：`tools/editor/editors/narrative_state_editor.py` 内 `validate_narrative_graphs` / `_validate_actions`（约 653-661）/ `_validate_conditions`（约 663-684）/ `_is_condition_shape` 一套。
- Runtime：`evaluateConditionExpr` / `evaluateConditionExprList` 独立求值，与上述校验无任何 import 关系。

代码漂移已发生：

- Web 报 `state.id.key.mismatch`（约 510 行），Python 报 `state.id.keyMismatch`（约 523 行）。
- Web `validateActions` 只检查数组与非空 `type`，不引用运行时 `ActionRegistry`，**未校验必需参数**。
- Python `_validate_actions` 同等级别。
- 双方对 quest / scenario / scenarioLine 条件**只做形状级检查**，缺 phase / status / lineStatus 的必填校验。

影响：

- UI 过滤、测试断言、问题统计无法稳定复用错误码。
- 规则变更只改一边就会破坏另一边。
- 严重问题大量降级为 `warning`，保存不会被阻塞（`NarrativeEditorApp.tsx` 559-567 行只筛 `severity === 'error'`）。

修复建议：

- 抽出 schema / validator 单一来源。可选：以 JSON Schema 或单一 TS 定义为权威，自动生成 Python 校验代码。
- Action 与 ConditionExpr 的校验必须引用 `ActionRegistry`，未注册 action、缺必需参数、quest/scenario 缺字段全部提升为 error。
- bridge `saveData`、Web 保存、主编辑器 Save All 三个入口**共用**这一套规则。

---

### H13. 编辑器结构：Graph 重命名不同步引用【成立】

`tools/narrative_editor_web/src/NarrativeEditorApp.tsx:872-873` GraphInspector 直接 `g.id = value`。对比 StateInspector 在 909-916 行通过 `renameStateInGraph` 触发 `updateTransitionEndpointRefs` / `updateLifecycleSignalRefs` 等批量同步（见 `editorModel.ts` 约 261-265 行）。

影响：

- Graph id 修改后，`{graphId, stateId}` endpoint、`stateEntered:oldGraph:state` 信号、`setNarrativeState.graphId`、condition 中 graph reads/emits 等引用**全部不同步**。
- 项目立刻进入引用悬空状态，且当前校验未必能检出。

修复建议：

- 引入与 State rename 对称的 `renameGraph` 操作，扫描并同步全部已知引用类型。
- 在 schema 层用结构化引用（而非字符串拼接 `oldGraph:state`），让 rename 不必扫描字符串。

---

### H14. 编辑器结构：高级 JSON Apply 不强制 validate + 引用同步【部分成立】

`tools/narrative_editor_web/src/NarrativeEditorApp.tsx:490-557` 的 `applySelectedJson` 在 rename 场景下会调用 `renameStateInGraph` / `renameTransition` / `renameElement`，并且外层 `updateData` 末尾会跑 `refreshProjectionAndValidation`（约 171-174 行）、`normalizeFile`（约 177-181 行）。

但缺口仍然存在：

- 没有「应用前必须先通过 validate」的硬门，error 级问题可以先污染编辑器状态再被「事后发现」。
- 对**整块 graph 替换**或非 rename 的端点/`setNarrativeState`/`stateEntered:*` 引用同步并未覆盖。

影响：

- 高级 JSON 编辑可以让编辑器进入「能展示但保存被挡」的中间状态，后续 UI 推导继续基于坏状态运行。
- 与 H13 / H7 叠加时，引用悬空更难追踪。

修复建议：

- Apply 前先跑 validate；error 级问题不允许 commit 到 store。
- 把引用同步抽成统一服务，与 rename / JSON apply / import 共用。

## 中优先级问题

### M1. Web 模拟器条件求值不完整【部分成立】

`tools/narrative_editor_web/src/editorModel.ts:419-433` 的 `evalCondition`：

- **已经支持** `all` / `any` / `not`（与原报告 R5 描述不符，需修正）。
- **未覆盖** `flag` / `quest` / `scenario` / `scenarioLine` 叶子，只支持 `narrative` + `state`。

而真实运行时（`evaluateGraphCondition.ts` 约 316-326 行委托 `evaluateConditionExpr`）支持完整叶子集合。

影响：

- 含 flag / quest / scenario 条件的 transition 在编辑器模拟中被判 false，作者以为不跳，游戏里实际会跳。

修复建议：

- 共用同一份 `evaluateConditionExpr`（TS 是同语言，可直接 import）。
- 如果不能完整求值，模拟器应在 UI 明确显示「模拟结果不完整：缺 flag / quest / scenario 求值」。

---

### M2. Web 校验过浅，错误被降级为 warning【成立】

`validateActions` / `validateConditions` 都是形状级检查，且大量问题用 `severity: warning`，而保存阻断只看 `error`（`NarrativeEditorApp.tsx` 559-567）。

修复建议（与 H12 协同）：

- unknown action、缺必需参数、scenario / quest 缺关键字段、ConditionExpr 形状错误全部提升为 error。
- 严格区分「数据错误」和「作者风险提示」，不要混在同一 severity 上。

---

### M3. 新建 transition 默认 `external:system:TODO:signal`【成立】

`editorModel.ts:171` 默认值 `'external:system:TODO:signal'`，`validateGraph` 在 529 行只拦截 `!t.signal?.trim()`，导致 TODO 占位信号可合法保存。

修复建议：

- 默认 signal 改为空字符串，并在校验中作为 error 阻断；或显式引入 `draft: true` / `disabled: true` 字段。
- 编辑器列表区高亮 TODO / 草稿 transition。

---

### M4. 无 bridge 时 Web 编辑器 localStorage 只写不读【成立】

`tools/narrative_editor_web/src/bridge.ts`：

- `loadNarrativeData` 在无 bridge 时 fetch `/assets/data/narrative_graphs.json`（约 55-58 行）。
- `saveNarrativeData` 无 bridge 时 `localStorage.setItem('narrative-editor-draft', payload)`（约 80-81 行）。
- 加载路径**没有任何 `narrative-editor-draft` 读取分支**。

影响：

- 浏览器刷新即丢草稿，UI 又显示「saved locally」。

修复建议：

- 加载顺序：local draft → runtime file → empty fallback，并在 UI 标注当前数据来源。
- 提供「清除草稿」按钮。

---

### M5. `derive_projection()` 数据源偏窄【成立】

`tools/editor/editors/narrative_state_editor.py` 的 `derive_projection`、`_iter_action_signal_sources`、`_iter_state_command_sources`、`_iter_condition_sources`（约 292-346、819-868 行）只扫 dialogue graph、scene/zone、water minigames、quest。

而 `project_model.py` 实际加载了 `document_reveals`、`archive/*`、`sugar_wheel`、`paper_craft` 等（约 73-79、153-189 行），且 `main_window.py` 也注册了对应编辑器，但**这些数据源全部没有进入投影遍历**。

影响：

- 画布投影不完整。作者以为某状态没人读 / 没人触发，实际运行时存在引用。

修复建议：

- 建立一个共享的 asset visitor（递归扫描所有 ActionDef 和 ConditionExpr，无论挂在哪种数据源上）。
- 新增功能模块时只注册一个 visitor，禁止再扩写 `derive_projection` 的硬编码分支。

---

### M6. 外部接线靠启发式推导【成立】

`_source_node_for_action`（约 910-924 行）依赖 `meta.emits` / `refId` / kind 的启发式匹配；`_source_node_for_condition`（约 958-967 行）按 dialogueBlackbox/refId、quest owner 配对。

影响：

- 推导关系不来自显式 authoring contract，难以解释、难以做去重 / 错误定位。
- 主画布把它当成与真实状态同级的核心结构，会强化作者对「图」语义的错觉。

修复建议：

- 把外部接线降级为「选中真实节点 / transition 后的关联视图」，不再当主画布一等公民。
- 长期方向：让 action / condition 在数据层显式承载 source 引用，而不是从字段反推。

---

### M7. 外部接线节点 ID 是字符串拼接【成立】

`_graph_node_index`（约 740-755 行）生成 `state:{sid}` / `subgraph:{elementId}:state:{sid}`；`_transition_anchor`（约 993-994 行）生成 `transition-anchor:{graphId}:{transitionId}`。

影响：

- 选择 / 定位 / 去重 / 解释链路全部依赖字符串拼接，含特殊字符的 id（H9）会进一步破坏。

修复建议：

- 引入结构化 endpoint 类型（dataclass / TypedDict / Pydantic 模型），UI 层只在显示时落字符串。

## 中低优先级问题

### L1. `ActionListField` 残留死代码【成立 / 已不可达】

`NarrativeEditorApp.tsx:1796-1902` 中，组件前段已切到 `editActionsNative`（约 1810-1850 行）走 Python/Qt ActionEditor，但**后段 1853-1901 行还保留旧的 select + `ActionParamsEditor` UI**。

复核结果：该旧代码位于 `return` 之后，运行时不可达，**不是「双 UI 并行」**。

影响：

- 维护者容易误改死代码路径，也容易让 review 失焦。

修复建议：

- 直接删除死代码块；如需保留参考实现，迁到 history / examples。

---

### L2. 切换 composition 不重置 `expandedElementIds`【成立】

`NarrativeEditorApp.tsx:614-623` 切换已存在 composition 时只 `setSelected(...)`，未清 `expandedElementIds`；而 New Composition 路径会 `setExpandedElementIds([])`（约 464-467 行），佐证这是疏漏而非有意。

影响：

- 跨 composition 同名 element id 可能错误展开其他子图，UI 状态不一致。

修复建议：

- 切换 composition 时统一清理 expandedElementIds / selection / hover 等子状态。

---

### L3. React Flow nodes / edges 双状态源【成立】

`NarrativeEditorApp.tsx` 约 161-169 行的 effect 会根据模型重算 nodes / edges；约 319-375 行的 `onConnect` 直接 `setEdges(addEdge(...))`，另外 307-316 行通过 `applyNodeChanges` / `applyEdgeChanges` 更新本地状态。

影响：

- 模型同步与本地手动 set 共存，瞬间重复边 / 脏边 / 选择错乱风险长期存在。

修复建议：

- 强制单数据源：所有编辑都先改模型，nodes / edges 仅作为模型派生视图。
- `onConnect` 不直接 setEdges，而是写回模型再让 effect 重算。

## 测试与验证

下列命令在合并审查前已执行（来自原报告，结果应在治理过程中保持绿）：

```bash
npm test
npm run build
.\.tools\Python311\python.exe -m unittest tools.editor.tests.test_narrative_state_editor -v
```

当前测试不能覆盖的关键路径（建议本轮新增）：

1. 图对话 / 文档揭示对 narrative 条件的求真（覆盖 H1）。
2. 跨图 transition 是否触发源 state `onExit` / `stateExited`（覆盖 H2）。
3. `setNarrativeState` / `applyStateCommand` 在违反 scenario 边界时是否被运行时拒绝（覆盖 H3）。
4. 同图 `stateExited` lifecycle transition 命中（覆盖 H4）。
5. drain 期间嵌套触发的 promise 顺序断言（覆盖 H5）。
6. 初始状态 `onEnterActions` 行为契约（覆盖 H6）。
7. Web → bridge → ProjectModel → 文件回写的端到端 dirty / flush / Save All（覆盖 H10、H11）。
8. 单一校验入口的 TS 与 Python 等价性测试（覆盖 H12、M2）。

## 建议修复顺序

按风险与影响排序，分三轮：

**第一轮（运行时正确性，必须先做）**

1. 统一 `ConditionEvalContext` 注入（H1）。
2. 修正跨图 transition 的源 state 退出语义（H2）。
3. `setNarrativeState` / `applyStateCommand` 兜住 scenario 边界（H3）。
4. 明确并修正 `stateExited` 生命周期顺序（H4）。
5. 修正 drain 期间的 promise 语义（H5）。
6. 初始状态 `onEnterActions` 行为契约确定（H6）。
7. 重复 graph id 拒绝注册（H7）。
8. `loadFromAsset` 异常上抛 / 结构化告警（H8）。
9. 信号 key 不再依赖冒号拼接（H9）。

**第二轮（工具链契约闭合）**

10. Web dirty / flush / confirm_close 全链路打通（H10）。
11. bridge `saveData` 入口强制校验（H11）。
12. 抽出 TS / Python / runtime 共享校验入口，提升保存阻断 severity（H12、M2、M3）。
13. Graph rename 引用同步（H13）。
14. 高级 JSON Apply 强制 validate / normalize / 引用同步（H14）。

**第三轮（编辑器体验与维护性）**

15. Web 模拟器复用 runtime 求值（M1）。
16. 默认 TODO signal 替换（M3）。
17. 加载草稿读取与显示（M4）。
18. 投影统一为 asset visitor（M5）。
19. 外部接线降级为解释层 + 结构化 endpoint（M6、M7）。
20. 清理死代码 / 状态隔离 / React Flow 单数据源（L1、L2、L3）。

## 最终判断

当前实现不是糊弄，但还停留在「能演示的工具雏形」。距离严谨的叙事工具链，差距集中在**三条契约还没真正闭合**：

- runtime 没有对 scenario 局部性、跨图边语义、生命周期顺序提供强约束。
- editor 的结构化模型、高级 JSON 编辑、Python bridge 校验不是同一个权威路径。
- 校验规则 TS / Python / runtime 各一份，已经在错误码层面开始漂移。

下一步优先不是继续加 UI，而是收敛这三件事：**运行时强约束 → 单一校验 / normalize 入口 → 外部接线降级为解释层**。测试也应围绕这三点补，而不是只验证「能 build」。
