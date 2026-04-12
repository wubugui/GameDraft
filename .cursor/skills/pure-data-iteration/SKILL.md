---
name: pure-data-iteration
description: Handles game iteration when only pure data changes are needed (no code). Checks whether current code and config structure can support the requested design; if not, reports gaps and suggestions and blocks for user approval. If supported, edits data then runs data validation until rules are satisfied, then notifies the user. Use when the user asks for 纯数据迭代, 只改数据, 改配置, 改数据不改代码, or any iteration that should touch only JSON/config graphs and not TypeScript or architecture.
---

# Pure Data Iteration

仅涉及修改纯数据（JSON、图对话、场景与各类 `public/assets/data` 配置）的迭代流程。不改代码，先确认能力再改数据，改完做数据校验，通过后通知用户。

## 何时使用

当同时满足以下条件时使用本技能：

- 用户需求可以通过**只改数据**完成（改 JSON、`dialogues/graphs/*.json`、场景配置等）
- 不涉及新增系统、改架构、改 TypeScript 逻辑
- 若需求需要改代码或改结构，应改用 `gameplay-iteration` 或 `feature-iteration`，并明确告知用户

触发表述包括：纯数据迭代、只改数据、改配置、改数据不改代码、加一条任务/遭遇/对话/规矩等（且你认为现有结构已支持）。

## 必须遵循的流程

### 1. 能力与结构检查（阻断式）

在动手改任何数据之前：

1. 根据用户需求，明确需要改动的**数据类型和结构**（例如：任务、遭遇、图对话、规矩、物品、商店、演出等）。
2. 查阅 `游戏架构设计文档.md` 中对应系统的数据约定，以及现有数据文件（如 `public/assets/data/*.json`、`public/assets/dialogues/graphs/*.json`、`public/assets/scenes/*.json`）的现有格式与字段。仓库中的 **`.ink`** 若存在，仅作可选编剧归档，**不以**其为运行时数据源。
3. 判断：**当前代码实现与配置结构是否已经支持用户想要的玩法**（例如：所需字段是否存在、引用关系是否被代码支持、是否有现成加载/解析逻辑）。

**若当前能力不足：**

- 不要开始编辑数据。
- 明确列出：缺什么（缺字段、缺类型、缺引用关系、缺代码支持等），以及你建议的下一步（例如：先做一次 feature 迭代增加某能力，或先扩展某 JSON 结构并同步改代码）。
- **阻断流程，等待用户审批或调整需求**。在用户确认前不继续。

**若当前能力足够：**

- 简短说明你将要改动的数据文件和大致改动点，然后进入步骤 2。

### 2. 编辑数据

- 只修改纯数据文件（JSON、场景配置、图对话 JSON 等），不修改 TypeScript 或构建配置。
- 保持与现有格式、命名、引用方式一致；如有约定，以 `游戏架构设计文档.md` 和现有数据为准。

### 3. 纯数据校验（迭代直到通过）

编辑完成后，必须做一轮**纯数据校验**：

1. **结构校验**：改动的数据是否符合既有格式（必填字段、类型、枚举值、层级关系）。
2. **引用校验**：所有跨文件或跨条目的 ID 引用是否存在且有效（例如：任务引用的 flag、遭遇引用的规矩、场景引用的热区/NPC、图对话中的 `next` 节点 id、`dialogueGraphId` 是否与 `graphs` 内文件一致等）。
3. **规则与一致性**：若项目中有数据规则说明（如玩法功能需求清单、规矩与遭遇的对应关系），检查本次改动是否满足这些规则。

**若不满足：**

- 列出具体不满足项与位置。
- 直接继续修改数据以修复问题，然后再次执行本步骤（纯数据校验），不进入步骤 4。

**直到校验通过后**，才进入步骤 4。

### 4. 通知用户

- 简要总结本次改动的文件和内容（例如：改了哪些 JSON、图对话、场景条目）。
- 说明校验已通过，并提示用户可在游戏中验证效果（如需）。

## 与其他技能的关系

- **gameplay-iteration**：涉及玩法设计、文档更新或需要改代码时使用；本技能仅限「只改数据」。
- **feature-iteration**：需要改 TypeScript、架构或工具时使用；本技能不改代码。
- 若在步骤 1 发现必须改代码或改结构才能满足需求，应明确告知用户并建议使用上述技能或先做能力扩展，然后阻断、等待用户决定。

## 校验参考来源

- 数据格式与字段约定：`游戏架构设计文档.md` 中各系统对 JSON / 图对话的说明。
- 现有数据样例与引用方式：`public/assets/data/`、`public/assets/dialogues/graphs/`、`public/assets/scenes/` 下的现有文件。
- 玩法与规则约束：若存在 `玩法功能需求清单.md` 或类似文档，校验时需考虑其中与数据相关的规则。
