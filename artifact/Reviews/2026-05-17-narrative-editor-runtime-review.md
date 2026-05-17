# 2026-05-17 Narrative Editor Runtime Review

## 审查范围

本次审查覆盖叙事状态机运行时、Web 叙事编辑器、PySide 主编辑器桥接与保存链路，以及与图对话、文档揭示、Action、ConditionExpr 相关的工具链契约。

重点查看模块：

- `src/core/NarrativeStateManager.ts`
- `src/systems/GraphDialogueManager.ts`
- `src/systems/DocumentRevealManager.ts`
- `src/systems/graphDialogue/evaluateGraphCondition.ts`
- `tools/narrative_editor_web/src/editorModel.ts`
- `tools/narrative_editor_web/src/bridge.ts`
- `tools/narrative_editor_web/src/NarrativeEditorApp.tsx`
- `tools/editor/editors/narrative_state_editor.py`
- `tools/editor/project_model.py`
- `tools/editor/main_window.py`

## 总体结论

这套叙事状态机已经能跑通当前 demo，但还没有达到严谨模块和工具开发标准。主要问题不是语法错误，而是运行时、Web 编辑器模拟器、PySide 桥、保存校验、投影分析各自维护一份近似逻辑，导致作者看到的结果、保存前校验结果和真实游戏运行结果可能不一致。

当前实现具备雏形，但存在明显临时工程痕迹：上下文注入不统一、dirty/save 契约不闭合、生命周期 signal 语义含混、校验过浅、投影扫描靠手写枚举。这些问题短期不一定阻塞演示，长期会让叙事作者被工具误导，并且让后续扩展成本快速上升。

## 高优先级问题

### 1. 图对话和文档揭示无法正确使用 narrative 条件

`ConditionExpr` 支持 `{ narrative, state }`，运行时求值依赖 `ctx.narrativeState`：

- `src/systems/graphDialogue/evaluateGraphCondition.ts:151`
- `src/systems/graphDialogue/evaluateGraphCondition.ts:250`

但以下模块自行构造 `ConditionEvalContext` 时没有注入 `narrativeState`：

- `src/systems/GraphDialogueManager.ts:179`
- `src/systems/DocumentRevealManager.ts:94`

影响：

- 图对话 `preconditions` 中的 narrative 条件永远不成立。
- 图对话 `choice.requireCondition` 中的 narrative 条件永远不成立。
- 图对话 `switch` 中的 narrative 条件永远不成立。
- `document_reveals.json` 中的 narrative 条件永远不成立。

这属于运行时语义错误，不是编辑器体验问题。

建议：

- 由 `Game.ts` 里的统一 `mkCondCtx` 注入到 `GraphDialogueManager` 和 `DocumentRevealManager`。
- 禁止各模块手搓 ConditionEvalContext。
- 增加覆盖用例：图对话 preconditions / choice / switch / document reveal 分别引用 narrative state。

### 2. 主编辑器保存契约是断的，Web 画布改动可能丢失

主编辑器 `Save All` 依赖各页签的 `flush_to_model()`：

- `tools/editor/main_window.py:641`

但叙事状态机页签当前实现：

- `tools/editor/editors/narrative_state_editor.py:269`：`flush_to_model()` 直接 `return True`
- `tools/editor/editors/narrative_state_editor.py:272`：`confirm_close()` 直接 `return True`

影响：

- 用户在 Web 画布中修改后，如果没有点击 Web 内部 Save，主编辑器 `Save All` 不会把 React state 拉回 `ProjectModel`。
- 关闭项目或切换项目时不会提示未保存变更。
- 这破坏了主编辑器统一保存模型，是工具链级别的严重问题。

建议：

- Web 侧维护 dirty 状态。
- 通过 QWebChannel 暴露 `getCurrentData` / `isDirty` / `flushToModel`。
- `NarrativeStateEditor.flush_to_model()` 必须主动从 Web 侧拉取当前数据并写入 `ProjectModel`。
- `confirm_close()` 必须根据 Web dirty 状态提示保存/丢弃/取消。

### 3. `stateExited:*` 生命周期触发语义有缺陷

`NarrativeStateManager.enterState()` 中：

- `src/core/NarrativeStateManager.ts:419` 先入队 `stateExited`
- `src/core/NarrativeStateManager.ts:421` 随后立刻把 active state 切到目标状态

而 `processTrigger()` 匹配 transition 时只检查当前 active state：

- `src/core/NarrativeStateManager.ts:338`

影响：

- 监听旧状态 `stateExited:graph:oldState` 且从旧状态出发的同图 transition 不会命中。
- 编辑器却把 `stateExited` 当成普通 signal 支持重命名和投影，造成作者预期与运行时行为不一致。

建议：

- 明确 lifecycle signal 是跨图通知还是本图离开钩子。
- 如果支持本图离开边，必须在 active state 切换前处理，或者为 lifecycle transition 建立专门匹配语义。
- 增加 `stateExited` 同图与跨图测试。

### 4. 队列 drain 期间触发信号会提前 resolve

`NarrativeStateManager.enqueue()` 中：

- `src/core/NarrativeStateManager.ts:305` push queue
- `src/core/NarrativeStateManager.ts:306` 如果已经 draining，直接返回 resolved Promise

影响：

- 调用方 `await emitNarrativeSignal()` 或 `await setNarrativeState()` 时，会误以为状态已经应用。
- 生命周期 action 内再次触发叙事信号时，动作顺序和 runtime snapshot 可能出现竞态。

建议：

- draining 时返回当前 `drainPromise`，或为每个 queued trigger 建立完成通知。
- 增加 action 内嵌套触发叙事 signal 的顺序测试。

### 5. Web 编辑器本地模拟器与真实运行时语义不一致

Web 侧本地模拟器：

- `tools/narrative_editor_web/src/editorModel.ts:359`

条件求值只支持 narrative state：

- `tools/narrative_editor_web/src/editorModel.ts:419`
- `tools/narrative_editor_web/src/editorModel.ts:424`

真实运行时支持：

- flag
- quest
- scenario
- scenarioLine
- narrative
- all / any / not

影响：

- 带 flag / quest / scenario 条件的 transition 在编辑器模拟中会被判 false。
- 作者可能误以为状态机不会跳转，但游戏中实际会跳。

建议：

- 共享运行时条件求值器。
- 如果 Web 侧不能完整求值，应明确显示“模拟器只支持 narrative 条件”，并把结果标为不完整。

### 6. 校验太浅，错误被降级成 warning，保存仍可通过

Web 侧：

- `tools/narrative_editor_web/src/editorModel.ts:611` 只检查 action 有 type
- `tools/narrative_editor_web/src/editorModel.ts:637` 只检查 ConditionExpr 大致形状

PySide 侧：

- `tools/editor/editors/narrative_state_editor.py:653`
- `tools/editor/editors/narrative_state_editor.py:675`

问题：

- 不校验 action type 是否存在于 `ActionRegistry`。
- 不校验 action 必需参数。
- 不校验 quest 条件必须有 status / questStatus。
- 不校验 scenario 条件必须有 phase / status。
- 多数严重问题只是 warning，保存不会被阻塞。

建议：

- 保存前 unknown action、缺参 action、无效 ConditionExpr 全部提升为 error。
- 复用主编辑器已有 Action schema 和 ConditionExpr 校验逻辑。
- 不允许 runtime 一定失败的数据通过保存。

## 中优先级问题

### 7. 新建 transition 默认写入假信号

`createTransition()` 默认 signal 为：

- `tools/narrative_editor_web/src/editorModel.ts:169`
- `external:system:TODO:signal`

而校验只拦截空 signal：

- `tools/narrative_editor_web/src/editorModel.ts:529`

影响：

- 占位信号可合法保存进入运行时。
- 后续排查时很难判断这是草稿、误配置还是保留信号。

建议：

- 默认 signal 为空并阻塞保存。
- 或添加 `draft: true` / `disabled: true` 等显式草稿语义。

### 8. 独立 Web 编辑器 localStorage 是只写不读

无 Qt bridge 时：

- 加载走 `fetch('/assets/data/narrative_graphs.json')`：`tools/narrative_editor_web/src/bridge.ts:53`
- 保存只写 `localStorage`：`tools/narrative_editor_web/src/bridge.ts:81`

影响：

- 浏览器刷新后不会读回本地草稿。
- 用户看到 `saved locally`，但下次加载丢失。

建议：

- 加载时优先读取 `narrative-editor-draft`。
- UI 显示当前数据来源：runtime file / local draft / empty fallback。
- 提供清除草稿按钮。

### 9. 投影分析靠手写枚举，漏数据源风险高

`derive_projection()` 只扫描部分数据源：

- dialogue graph
- scene / zone
- water minigames
- quest

相关位置：

- `tools/editor/editors/narrative_state_editor.py:819`
- `tools/editor/editors/narrative_state_editor.py:845`
- `tools/editor/editors/narrative_state_editor.py:939`

但项目中还有 sugar wheel、paper craft、document reveals、archive、cutscene 等可能持有 actions 或 conditions。

影响：

- 画布投影不完整。
- 作者以为某个状态没人读/没人触发，实际运行时存在引用。

建议：

- 建立共享 asset visitor，扫描所有 ActionDef 和 ConditionExpr。
- 新增功能模块时只注册 visitor，不手写进 `derive_projection()`。

### 10. 运行时加载失败会静默降级为空状态机

`NarrativeStateManager.loadFromAsset()` 捕获任何异常后注册空图：

- `src/core/NarrativeStateManager.ts:164`
- `src/core/NarrativeStateManager.ts:169`

影响：

- 坏 JSON / 坏 schema / 资源路径错误都会表现为“叙事系统没反应”。
- 开发期不容易定位。

建议：

- dev mode 下 hard fail 或 DebugPanel 明显报错。
- production 下至少记录结构化错误并暴露到 runtime snapshot。

### 11. 初始状态的 onEnterActions 永远不会在注册图时执行

`registerGraphs()` 只设置 active state 和投影 flag：

- `src/core/NarrativeStateManager.ts:174`
- `src/core/NarrativeStateManager.ts:185`
- `src/core/NarrativeStateManager.ts:187`

没有执行 initialState 的 `onEnterActions`，也没有发 `stateEntered`。

影响：

- 编辑器允许给 initial state 配 onEnterActions，但运行时不会执行。
- 作者预期容易出错。

建议：

- 明确 initial onEnter 是否执行。
- 如果不执行，编辑器应禁止或警告 initialState.onEnterActions。
- 如果执行，需要避免读档反复触发。

### 12. Web / Python 双份校验已经开始漂移

同类问题 code 不一致：

- Web：`state.id.key.mismatch`
- PySide：`state.id.keyMismatch`

位置：

- `tools/narrative_editor_web/src/editorModel.ts:510`
- `tools/editor/editors/narrative_state_editor.py:523`

影响：

- UI 过滤、测试断言、问题统计无法稳定复用。
- 后续规则变更容易只改一边。

建议：

- 抽出共享 schema / validator。
- Python 侧调用同一份规则，或从同一规则表生成 Python / TypeScript 校验代码。

## 测试与验证

已执行：

```bash
npm test
```

结果：

- 7 个测试文件通过
- 43 条用例通过

已执行：

```bash
npm run build
```

结果：

- 主游戏构建通过
- narrative editor 构建通过

已执行：

```bash
.\.tools\Python311\python.exe -m unittest tools.editor.tests.test_narrative_state_editor -v
```

结果：

- 8 条叙事编辑器 Python 单测通过

说明：

- 项目内 Python 环境没有安装 pytest，因此 `python -m pytest tools\editor\tests\test_narrative_state_editor.py` 无法执行。
- 使用 `unittest` 直接运行该测试模块可以通过。

## 建议修复顺序

1. 统一 `ConditionEvalContext` 注入，修复 GraphDialogueManager / DocumentRevealManager 的 narrative 条件失效。
2. 修复 Web 叙事编辑器 dirty / flush / confirm_close / Save All 契约。
3. 明确并修复 `stateExited` 生命周期语义。
4. 修复 draining 队列 promise 语义。
5. 抽出共享 ConditionExpr / Action 校验器，并把严重问题提升为 error。
6. 让 Web 本地模拟器复用真实运行时条件语义。
7. 替换 `TODO:signal` 占位策略。
8. 重做投影扫描为统一 asset visitor。

## 最终判断

当前实现不是完全糊弄，但还处于“能演示的工具雏形”，距离严谨的叙事工具链还有明显差距。真正需要优先治理的是契约一致性：运行时怎么跑、编辑器怎么模拟、保存前怎么校验、投影怎么解释，必须共用同一套语义。否则这个系统规模一大，问题会从单点 bug 变成作者无法信任工具。
