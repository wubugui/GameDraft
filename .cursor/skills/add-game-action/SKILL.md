---
name: add-game-action
description: Registers a new ActionExecutor action in GameDraft with editor support and validation. Use when the user asks to add an action, command, 新动作, 新 Action, 指令, 添加命令, ActionRegistry, or extend hotspot/quest/encounter actions. Covers ActionRegistry.ts, action_editor.py, optional Game deps, and validator expectations.
---

# 添加游戏 Action（项目约定）

在 GameDraft 中，**一条可用的 Action = 运行时注册 + 主编辑器可配置 + 数据校验认可**。只做其中一步视为未完成。

## 术语

策划或口语里的 **command / 命令 / 指令** 在多数场景下与本文的 **Action** 同指：数据中为 `{ "type": "...", "params": { ... } }`，由 **`ActionExecutor`** 执行（热区、区域、任务奖励、遭遇结果、延迟事件嵌套等）。若用户指的是 **演出（cutscene）时间线里的 `commands`**，其字段与 `ActionDef` 不同，须按 `cutscenes` 数据与 `CutsceneManager` 单独处理，**不完全等同**本 Skill 的流程。

## 审批与范围（必须先判断）

- **可自主完成（最小改动）**：在 `ActionRegistry` 中新增 `executor.register`，**不**扩大 `ActionRegistryDeps`、**不**改 `ActionExecutor` 内置逻辑、**不**改 `validator` 的遍历结构；在 `action_editor` 中仅增加类型与参数字段或小型专用表单。
- **需要用户确认 / 审批后再做**：新增或修改 `ActionRegistryDeps`（牵涉 `Game` 与多系统耦合）、改动现有 action 的语义或参数约定、调整 `validator._walk_action_defs` 以外全局校验策略、重构 `ActionRow`/`ActionEditor` 共享行为、或该动作会**实质改变玩法结果**（奖励、进度、规矩、遭遇结局等）——后者应同步对照 `gameplay-iteration` 与玩法文档。

## 实施清单（按顺序）

1. **`src/core/ActionRegistry.ts`**
   - `registerActionHandlers` 内 `executor.register('类型名', handler, ['param', ...])`。
   - `handler` 只做本动作所需逻辑；`paramNames` 与编辑器字段一致便于维护。
   - 若需 `Game` 或其它系统能力：在 **`ActionRegistryDeps` 接口**中增加依赖，并在 **`Game.ts`** `registerActionHandlers({ ... })` 传入实现。**此类扩展属「需审批」范围。**

2. **`tools/editor/shared/action_editor.py`**
   - 将类型名加入 **`ACTION_TYPES`**（否则策划无法在下拉框中选到）。
   - 在 **`_PARAM_SCHEMAS`** 中声明参数 `(字段名, 类型)`：`str` / `int` / `bool` / `flag_val`；无参动作用 `[]`（与 `resetPlayerAvatar` 类似）。
   - 复杂参数（如 `enableRuleOffers` 的 slots、`setPlayerAvatar`、`addDelayedEvent` 嵌套动作）：在 **`_rebuild_params`** / **`to_dict`** 中增加 **`act_type == '你的类型名'`** 分支，**禁止**为省事删掉或改写其它类型的分支。

3. **嵌套 Action**
   - 若新动作的 `params` 内含 **`ActionDef[]`**（例如子动作列表），必须在 **`tools/editor/validator.py`** 的 **`_walk_action_defs`** 中为该类型增加递归（与 `enableRuleOffers`、`addDelayedEvent` 同级），否则子动作不会参与「类型已登记」校验。**新增递归属「需审批」范围**（影响全局校验行为）。

4. **校验**
   - `validator` 会对数据中出现的 `action.type` 与 **`ACTION_TYPES`** 比对；未登记会报 **error**。新增类型后运行主编辑器 **Validate Data** 或等价调用 `validate(model)` 做冒烟。
   - **`npm run ink:compile`**（`scripts/compile-ink.cjs`）会遍历编译后的 `.ink.json` 中所有 `# action:` 标签，与 **`action_editor.py` 的 `ACTION_TYPES`** 比对；未登记类型会导致 **编译失败退出码 1**。

5. **异步 handler**
   - 若 handler 需 `async`（如加载资源），在 `register` 内使用 `void promise.catch(...)`，**不要**把 `ActionExecutor.execute` 改成 async（影响全链路）。

## 不要做的事

- 不要只改 TypeScript 不更新 `action_editor`（违反项目约定，且校验会报错）。
- 不要顺带重排、重命名其它 action 类型或共用表单逻辑。
- 不要把手写 JSON 当作常态；编辑器必须能生成等价结构。

## 参考位置

- 运行时注册与依赖：`src/core/ActionRegistry.ts`、`src/core/Game.ts`（`registerActionHandlers`）。
- 内置（非 Registry）：`src/core/ActionExecutor.ts` 中的 `setFlag`、`showNotification`；若在此新增类型，**仍须**在 `action_editor` 中登记。
- 表单与类型列表：`tools/editor/shared/action_editor.py`。
- 数据内 Action 扫描与类型校验：`tools/editor/validator.py`（`_walk_action_defs`）。
- 动作数据挂载位置（与 `action_registry_editor` 扫描一致）：任务 `acceptActions`（接取时）与 `rewards`（完成时）、遭遇 `options[].resultActions` 与 `rewards`、场景热区 `data.actions`、区域 `onEnter`/`onStay`/`onExit`、`enableRuleOffers` 内 `slots[].resultActions`、`addDelayedEvent.params.actions` 等。

## 完成后

- `npx tsc --noEmit`。
- 对本次改动涉及的编辑场景做一次手动点选（例如场景里加一条该动作并保存），确认无回归。
