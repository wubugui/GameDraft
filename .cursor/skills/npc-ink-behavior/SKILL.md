---
name: npc-ink-behavior
description: Guides planning and implementing NPC behavior in Ink dialogue for GameDraft—requirements assessment, gap analysis against existing ink integration, optional new EXTERNAL functions via add-ink-external, and post-iteration review. Use when the user writes or requests Ink scripts for NPC behavior, NPC 对话 ink, ink 定义 NPC 行为, ink 剧情脚本, or character dialogue knots tied to npc:interact.
---

# NPC 行为 Ink 脚本迭代

## 何时启用

用户要为 NPC 编写或修改 **Ink** 对话以定义其行为、分支、条件与标签效果时，先读本 Skill再动手。

## 项目集成要点（必读）

- **运行时**：`DialogueManager` 加载 `public/assets/dialogues/*.ink` 编译后的 JSON；`bindInkExternals` 绑定 [`src/data/inkExternals.ts`](src/data/inkExternals.ts) 中声明的外部函数。
- **EXTERNAL**：仅在 Ink 中 `EXTERNAL 函数名(...)` 且在 `INK_EXTERNALS` + `bindInkExternals` 中注册才有效；编辑器从 TS 解析元数据（见 [`add-ink-external`](../add-ink-external/SKILL.md)）。
- **行内标签**（`DialogueManager` 处理）：常见如 `# action:...`（执行 ActionExecutor 语义）、`# speaker:...`；过滤与解析逻辑在 `DialogueManager`，**不是** Ink 内置能力。改新标签类型通常要改 TS，与「加 EXTERNAL」不同。
- **与 Action 数据区别**：热区/任务里的 **ActionDef** 走 `ActionExecutor`，合同在 ActionRegistry；Ink 里调运行时能力优先用 **EXTERNAL** 或已有 **`# action:...`** 约定，勿混用术语。

## 阶段 1：需求与信息根据用户描述，确认或向用户追问（缺则问，一次只问关键1～2 批）：

| 项 | 说明 |
|----|------|
| NPC / 场景 | 哪个 NPC、哪张场景、对话 JSON 路径或与现有 `.ink` 文件关系 |
| 入口 knot | 例如 `=== start ===` 或与 `npc:interact` 加载的故事入口是否一致 |
| 行为类型 | 纯台词 / 分支 / 依赖 flag或物品 / 要改世界状态（给规则、设 flag、给物品等） |
| 现有能力是否够 | 能否用已有 `getFlag` / `getCoins` + `# action:...` 完成；是否需要读存档里没有的实时量 |

## 阶段 2：差距评估

1. **读** [`src/data/inkExternals.ts`](src/data/inkExternals.ts) 与示例 [`public/assets/dialogues/*.ink`](public/assets/dialogues)（如 `test_npc.ink`：`EXTERNAL`、`# action:setFlag:...`）。
2. **判断**：
   - 仅剧情结构与现有 EXTERNAL + `action:` 标签即可 → 直接改 `.ink`，编译 JSON，必要时跑 `npx tsc --noEmit`（无 TS 改动时可省略）。
   - 需要 **Ink 表达式里**调用新运行时能力（新查询、新副作用）→ 通常需要 **新 EXTERNAL** 或扩展 `InkExternalDeps`；若用户要的是「新标签语义」或「新对话管线能力」→ 可能要改 **`DialogueManager`**（或相关 UI），范围更大，须与用户确认。
3. **向用户说明**差距：缺什么、推荐方案（优先复用 `action:` 还是加 EXTERNAL）、若加 EXTERNAL 会动哪些文件。

## 阶段 3：用户同意后的实施

- **新增 / 修改 EXTERNAL**：**必须先阅读并遵循** 项目 Skill [`add-ink-external`](../add-ink-external/SKILL.md)（`inkExternals.ts`、`DialogueManager` 注入、`.ink` 顶部 `EXTERNAL`、编译与编辑器校验）。
- **仅 Ink 文本**：编辑 `public/assets/dialogues/*.ink`，按仓库流程编译为 `*.ink.json`（与现有 `scripts/compile-ink.cjs` / 文档一致）。
- **不要**只在 `.ink` 写 `EXTERNAL` 而不改 `inkExternals.ts` 与绑定。

## 阶段 4：迭代后 Review（自检清单）

完成改动后，在回复中做一次简短审查，勾选逻辑上是否成立：

- [ ] `.ink` 中每条 `EXTERNAL` 均在 `INK_EXTERNALS` 与 `bindInkExternals` 中有对应实现。
- [ ] `# action:...` 等形式与 `ActionExecutor` 已注册类型一致（未知 type 会数据校验失败或运行时不生效）。
- [ ] 条件分支与 flag / 物品 key 与策划命名一致，无拼写错误。
- [ ] 故事入口、knot、`->` 跳转与 NPC 配置的对话资源路径一致。
- [ ] 已执行：`npx tsc --noEmit`（有 TS 改动时）；Ink 已重新编译；主编辑器侧无 Unknown EXTERNAL / 参数错误（若用户用编辑器）。
- [ ] 若新增依赖注入：无循环依赖，`DialogueManager` 构造处传入完整 `InkExternalDeps`。

## 原则

- **先评估、再实现**；能力缺口先和用户对齐，再写代码或 Ink。
- **EXTERNAL 迭代**走 `add-ink-external`，保证合同、绑定、声明、校验闭环。
- **保持简洁**：不写与当前 NPC Ink 需求无关的大范围重构。
