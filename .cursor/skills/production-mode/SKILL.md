---
name: production-mode
description: >-
  策划模式（做游戏内容时的工作流）。当用户要做内容、改数据、加任务/支线/对话/遭遇/规矩/演出/场景交互/物品/商店/档案/小游戏等，且希望"以数据为主、人类仍能用编辑器维护"时使用。
  触发词：策划模式、做内容、改 json、改数据、加任务/对话/演出/遭遇/规矩、production mode、关卡/剧情制作。
  本模式默认代码只读、只写 JSON；纯数据写不出来时按 L1/L2/L3 阶梯升级（L2 自动新增 command，L3 跳过并汇报）；所有写出的 JSON 必须保证编辑器能打开并往返编辑。
---

# 策划模式（Production Mode）

做游戏内容（改 JSON 数据）时的工作流。**默认代码只读、只写数据**；当纯数据实现不了时按阶梯升级，绝不偷改代码绕过、绝不假实现敷衍；写出的每一处 JSON 都必须保证**人类仍能用编辑器打开并原样存回**。

本项目是 AI 与人类协作开发：**AI 直接改 JSON，人类仍只通过编辑器维护 JSON**。所以"编辑器可往返"是硬约束，不是可选项。

## 何时使用

需求属于"做内容"时使用：任务/支线/主线、对话分支、遭遇/规矩/规矩碎片、物品/货币/商店/掉落、场景交互/热区/区域/解锁、演出、档案（人物簿/见闻录/杂书匣/书籍）、地图节点、小游戏配置、文案等。

- 若是**不改玩法的纯技术改动**（重构、架构修复、性能、工具）→ 用 `feature-iteration`。
- 若需求会**改变玩法设计的含义**（需要先更新玩法文档、做设计取舍）→ 先走 `gameplay-iteration` 审查玩法一致性，再回本模式做数据。
- 若要求**绝对一行代码都不碰**（含不许新增 command）→ 用更严格的 `pure-data-iteration`。本模式允许 L2 受控地新增 command。

## 三条总规则（模式红线）

1. **代码只读**。`src/**`、`tools/**` 等代码默认只读不写。**唯一允许的代码改动**是 L2 升级——为打通数据需求而新增一个能力原语（见第三节），且必须按既定约定 + 上报。除此之外不得改代码。
2. **写不出来就升级/上报，不糊弄**。纯 JSON 实现不了时走 L1→L2→L3。**严禁**：偷偷改业务代码绕过机制、用假数据/空实现/占位敷衍、把动作硬塞到不该去的结构里、明知引用不存在还照写。
3. **JSON 必须"编辑器可往返"**。见第四节硬契约。违反会导致人类一保存就丢数据或炸出全文 diff。

## 进入本模式即载入：事件流程编排能力（core，做叙事内容必备）

本项目公理:**只要需求涉及情节事件,就是叙事**——主线/支线/微型任务/小遭遇/复杂见闻,全走同一套信号脊椎,没有"轻量旁路"。因此任何"涉及事件"的内容,动手前**必须先载入并遵循** `agent_docs/content/methods/narrative-flow-authoring.md`(事件流程编排工作法)。这是本模式做叙事内容的 full 能力,概要:

- **公理**:事件=叙事走一套信号脊椎;类型=三旋钮(规模/落位/呈现面)非选系统;**进度走信号、flag 只在 state.onEnterActions 派生,绝不堆全局 flag 推进度**。
- **正交五关**:摸状态+定三旋钮 → 建叙事状态机骨架 → 加实体被叙事引用 → 地图落点 → 位面(整套规则切换才开)。
- **判断力**:三旋钮怎么拧、进不进位面、一拍是否由**真实内容**末态派生信号喂(非替身桩)。
- **边界**:甜区=中型开放世界;跨 flow 查询(`narrative` 叶查任意图状态,含模板化 `flow_{{taskId}}`)是一等能力;线性主图 / 读取侧反查工具是两堵墙。
- **协作**:形状归策划、接线归 agent,先给可视化接线地图对齐落点再动手。
- 单拍怎么落 → `agent_docs/content/recipes/wire-demo-beat.md`;运行时模型 → `agent_docs/runtime/mechanisms/narrative-signal-spine.md`;位面 → `agent_docs/runtime/mechanisms/plane-system.md`。

## 一、入口能力检查（阻断式，先做）

动手改任何数据前：

1. 明确需求要改动的数据类型与结构（任务？对话图？遭遇？场景热区？演出？……）。
2. 读对应的现有数据样例与 schema：`public/assets/data/*.json`、`public/assets/scenes/*.json`、`public/assets/dialogues/graphs/*.json`、`public/assets/data/cutscenes/index.json`；类型定义参考 `src/data/types.ts`。**做内容前先查 `docs/editor-authoring-surface.md`**——它逐面板列出编辑器实际暴露的可编辑字段、操作能力与危险区，定义了"哪些字段能安全写"。
3. 用第三节的 L1/L2/L3 判定：这个需求纯数据能不能做？
   - 能（L1）→ 简述将改哪些文件，进入第二节实施。
   - 缺一个能力原语（L2）→ 进第三节 L2 流程。
   - 超出单点扩展（L3）→ 记录、跳过、最后汇报。

## 二、数据侧机制铁律（必须走的通道）

这些在代码层面是强制的，绕过的写法运行时被静默跳过或编辑器拒绝保存。五通道：
**行为走 command、成段演出走 cutscene（内禁改存档+白名单；单发反馈 showEmote/playScriptedDialogue/playNpcAnimation 例外）、条件走统一条件表达式（六类叶子 `flag / quest / scenario / scenarioLine / narrative / plane` + all/any/not）、对话分支走图对话 graph、玩家可见文本走 `[tag:…]`。**

各通道的权威清单指针、挂载点与细则 → `agent_docs/content/mechanisms/content-expression-channels.md`；`[tag:]` 系统细则 → `agent_docs/content/mechanisms/text-ref-tag-system.md`。权威清单以代码为准（如 `action_editor.py` 的 `ACTION_TYPES`），不要照抄架构文档旧表。

**场景实体的迁移/改名/删除是重构操作，不要手搓 JSON 追引用网**：调 `tools/editor/shared/entity_refactor.py` 引擎（无头：`load_project → scan_entity_usages 看影响面 → move_entity / rename_entity / delete_entity → save_all`），引用机械改写+分类报告+可撤销。裸 id 引用运行时按当前场景解析、断了**静默跳过且校验可能全绿**，手搓必踩。细则 → `agent_docs/content/mechanisms/entity-refactor-engine.md`。

## 三、升级三级阶梯

对每个需求依次自问：①是副作用还是成段演出？②需要的能力有没有对应的已注册 command？③参数在该 command 的 schema 里吗？④触发条件能用六类叶子的布尔组合写出吗？⑤需要运行时算术 / 跨变量取值 / 集合遍历吗？

### L1 — 纯数据可达（默认路径）

能用「已注册 command × 允许的 param × 六类条件 × 图节点 × `runActions`/`chooseAction`/`randomBranch` 控制流」拼出来 → **直接在 JSON 实现**。

### L2 — 缺一个能力原语 → 自动新增 command（受控代码改动）

判定：需要一个不存在的能力原语——新 command、某 command 缺一个 param、新 cutscene present 类型、新条件叶子、新图节点。典型："扣 N% 铜钱""按好感度算价""隐藏全场某类 NPC"（当前数据层无运行时算术与集合寻址）。

处理（**本模式唯一允许的代码改动**）——登记面知识与三坑详见
`agent_docs/content/mechanisms/l2-action-primitive-registration.md`：

1. **优先确认真的是 L2**，不是 L1 没拼对，也不是 L3 子系统级缺口。
2. 切到代码模式，按 `add-game-action` 的三件套新增能力原语，缺一不可：
   - 运行时注册：`src/core/ActionRegistry.ts` 的 `executor.register(...)`（或对应机制：present 类型改 `CutsceneManager`/renderer；条件叶子改 `evaluateGraphCondition.ts`；图节点改 `DialogueGraphNodeDef` + `GraphDialogueManager`）。
   - 编辑器可配：`tools/editor/shared/action_editor.py` 的 `ACTION_TYPES` + `_PARAM_SCHEMAS`（含嵌套 `ActionDef[]` 时改 `validator.py` 的 `_walk_action_defs`）；若要进 cutscene，同步 `cutscene_action_allowlist.json`。
   - 校验认可：新 type 必须能通过 `validator.validate`。
3. **以最小必要改动新增**，不顺手重构、不改既有 command 语义。若新增会**实质改变玩法结果**（奖励/进度/规矩/遭遇结局），先按 `gameplay-iteration` 对照玩法文档。
4. 新增后跑 `npx tsc --noEmit` + 数据校验（第五节），回到 JSON 用新原语完成需求。
5. **完成后明确告知用户**：本次为打通需求新增了哪个 command/原语、改了哪几个文件。

### L3 — 超出单点扩展 → 跳过 + 汇报

判定：需要全新子系统/新玩法/新存档结构/未建模实体属性，加一个原语也撑不住。

处理：**不硬做、不假实现**。记录该任务、说明缺什么，**跳过**它继续其余任务，**在本轮最后统一汇报所有被跳过的任务**及建议。

## 四、编辑器往返硬契约（保证人类还能用编辑器打开）

违反会导致人类一保存就丢数据或炸出全文 diff：

**A. 格式（硬性）**
- 一律 `ensure_ascii=False` + **2 空格缩进** + 文件末尾单个换行，UTF-8。**中文不转义**成 `\uXXXX`。
- **不排序键**，保持插入顺序；改已有文件时不挪动未触碰的键的位置。

**B. 只改编辑器管理的文件**
- ✅ 可写：`public/assets/data/**`（items/quests/questGroups/encounters/rules/shops/map_config/audio_config/strings/scenarios/document_reveals/overlay_images/flag_registry/pressure_holds/signal_cues/game_config、archive/*、cutscenes/index.json、filters/*、water_minigames|sugar_wheel|paper_craft 的 index+实例）、`public/assets/scenes/*.json`。
- ✅ 走独立编辑器（同样 2 空格 / 不转义约定）：`public/assets/dialogues/graphs/*.json`、`narrative_graphs.json`。
- 🚫 不要碰：`anim.json`（编辑器只读、靠 `video_to_atlas` 导出，AI 改了人类无法用 GUI 维护）、`.ink`（无 GUI 且非运行时主路径）、`public/resources/runtime/**` 媒体。

**C. 字段层面（防静默丢数据）**——重建区/deprecated/盲区/ID 一致性的完整细则见
`agent_docs/content/mechanisms/editor-roundtrip-contract.md`（字段级地图另见
`docs/editor-authoring-surface.md`）。三条头等纪律：**重建区只能写编辑器认识的字段**（塞
自定义键会被人类开一次面板抹掉）；**deprecated 字段别写**（编辑器主动删）；**盲区即升级
信号**（编辑器没暴露、运行时支持的字段——落到这里按 L2 升级或上报，不要闷头写人类用
GUI 维护不了的 JSON）。

**D. 引用必须有效（最硬的闸门）**
- 所有 `[tag:item:X]`/`[tag:flag:X]`/`[tag:string:cat:key]` 等的目标**必须存在**，否则编辑器保存时直接 `raise`、整个工程存不了。strings 之间不能有引用环。
- 跨文件 ID（`targetScene`/`encounterId`/`dialogueGraphId`/`nextQuests`/`requiredRuleId`/cutscene id…）必须指向真实存在的对象。

## 五、收尾校验（每次改完 JSON 必做，迭代到通过）

> 命令、退出码与校验盲点的权威配方：`agent_docs/content/recipes/content-validation-gate.md`。

1. **结构可解析**：改过的每个文件能被 `json.loads` 解析，根类型正确（scenes 根=对象、map_config 根=数组、scenarios 根=带 `scenarios` 的对象、对话图根=带 `nodes` 对象与合法 `entry`）。
2. **素材引用审计（有 CLI，必跑）**：
   ```
   python -m tools.editor.shared.asset_reference_audit . --strict
   ```
   抓"引用了磁盘上不存在的图/音/动画"。
3. **全量数据校验**（抓 action type 未登记、跨文件引用断裂、必填/枚举、`[tag:]` 失效、废弃字段等）——编辑器 "Validate Data" 的命令行形式：
   ```
   ./dev.sh validate-data                 # 或 python -m tools.editor.validate
   ./dev.sh validate-data -- --strict     # warning 也算失败（经 dev.sh 转参要加 --）
   ./dev.sh validate-data -- --errors-only # 只看 error
   ```
   退出码：0=无 error；1=有 error（`--strict` 下 warning 也算）；2=工程加载失败。**不查素材文件是否存在**（那是第 2 步）。
4. **校验抓不到、要自己当心的**：对话图**内部 `next` 跳转完整性**（全量校验不查节点间连边）、素材文件存在性（靠第 2 步）、大量引用只报 warning 不报 error——**不能"没 error 就当对了"**，warning 也要逐条看。

不通过就继续改数据修复，再跑校验，直到结构/引用都干净，才算完成。

## 六、结束时的汇报格式

- 本次做了什么内容，改了哪些 JSON（按文件列）。
- 是否触发过 L2（新增了哪个 command/原语、改了哪些代码文件）。
- 校验结果：素材审计 + 全量校验是否干净，残留 warning 说明。
- L3 跳过的任务清单及原因/建议。
- 提示用户可在编辑器中打开核对、在游戏中验证效果。

## 额外限制

- 不要把一次内容需求扩展成大范围重构。
- 不要在引用无效/校验不通过时就结束。
- 不要为省事在嵌套结构里塞编辑器不认识的字段。
- 不要把"能 json.loads"当作校验通过；必须跑素材审计 + 全量校验。
- L2 新增 command 只做"打通需求所需的最小原语"，不顺手扩 `ActionRegistryDeps` 之外的耦合、不改既有 action 语义（这些属需用户审批范围）。
