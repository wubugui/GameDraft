---
name: add-ink-external
description: Adds or updates an Ink story external function in GameDraft (inkjs BindExternalFunction, TS contract, .ink declarations, editor validation). Use when the user asks for Ink external, EXTERNAL, ink 外部函数, bindInkExternals, inkExternals.ts, or dialogue script calling into the game runtime.
---

# 添加 Ink 外部函数（项目约定）

对话 `.ink` 通过 **`EXTERNAL`** 声明、运行时 **`story.BindExternalFunction`** 绑定；**`src/data/inkExternals.ts`** 是唯一合同源，主编辑器用 Python 从该文件解析元数据做校验与补全。

## 实施清单（按顺序）

1. **`src/data/inkExternals.ts`**
   - 在 **`INK_EXTERNALS`** 增加条目：`函数名: []`（无参）或 `[{ name: '参数名', completion: 'flag_key' | 'item_id' | 'scene_id' | 'string' | 'number' }]`。格式需与同文件现有条目一致，否则 **`tools/editor/editors/ink_parser.py`** 的正则可能解析不到。
   - 若实现需要新系统引用：扩展 **`InkExternalDeps`**，并在 **`bindInkExternals`** 内增加 **`story.BindExternalFunction('函数名', 回调, true)`**（与现有 `getFlag` / `getCoins` 一致，第三个参数保持 `true`）。
   - 返回值类型须与 Ink 脚本中的用法一致（例如布尔常用 `1/0` 表示）。

2. **`src/systems/DialogueManager.ts`**
   - 在 **`bindInkExternals(this.story, { ... })`** 传入 **`InkExternalDeps`** 所需的全部字段。新增依赖即修改此处构造对象。**牵涉对话系统与多管理器耦合时，改动前与用户确认范围。**

3. **`.ink` 源文件**
   - 每个使用该函数的脚本顶部增加 **`EXTERNAL 函数名(参数列表)`**，与注册名、参数个数一致。

4. **编译与校验**
   - 运行 **`npx tsc --noEmit`**。
   - 按工程流程将 `.ink` 编译为 **`public/assets/dialogues/*.ink.json`**（与现有对话管线一致）。
   - 重新加载主编辑器工程后，`discover_ink_externals` 会重读 `inkExternals.ts`；在对话浏览器或相关校验中确认无 **Unknown EXTERNAL** / 参数个数错误。

## 不要做的事

- 只在 `.ink` 里写 **`EXTERNAL`** 而不改 **`inkExternals.ts`**：运行时会未绑定，编辑器会报未注册。
- 随意改写 **`ink_parser.py`** 中解析 `INK_EXTERNALS` 的正则，除非同步更新 TS 书写格式并做编辑器冒烟。

## 与 Action 的区别

- **Ink EXTERNAL**：供 **ink 运行时** 在剧情表达式中调用的函数，合同在 **`inkExternals.ts`**。
- **Action（ActionDef）**：供 **ActionExecutor** 在热区、任务、遭遇等数据里执行；流程见 **`add-game-action`** Skill。二者不要混用术语。

## 参考文件

- 合同与绑定：`src/data/inkExternals.ts`
- 注入依赖：`src/systems/DialogueManager.ts`
- 编辑器解析与 Ink 诊断：`tools/editor/editors/ink_parser.py`（`discover_ink_externals`）、`tools/editor/project_model.py`（加载工程时刷新）
- 示例声明：`public/assets/dialogues/*.ink` 文件首行 `EXTERNAL ...`
