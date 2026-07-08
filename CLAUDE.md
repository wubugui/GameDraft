# GameDraft — Claude 工作规则

> 本文件每次会话自动载入。**开工先按 §0 判定任务类型，再遵守对应那一套规则。**
> **列举型内容以代码为准**：架构文档（`docs/游戏架构设计文档.md`）的清单会漂移——Action 清单查 `tools/editor/shared/action_editor.py` 的 `ACTION_TYPES`，游戏状态查 `src/data/types.ts` 的 `GameState`，条件叶子查 `src/systems/graphDialogue/evaluateGraphCondition.ts`。不要照抄文档里的表。

## §G Skill / Workflow 治理台入口

做 skill / workflow 治理、治理包拆分、Codex / Claude agent 任务分发时，不要靠 dashboard 截图或页面肉眼信息判断。先刷新并读取结构化上下文：

```bash
python3 -B tools/skill_workflow_governance/govern.py audit
```

优先引用这些入口：

- `tools/skill_workflow_governance/out/agent-context-current.md`：给 Codex / Claude 直接读取的便携上下文包。
- `tools/skill_workflow_governance/out/registry.json`：完整机器可读审计状态。
- `governance://hub`：连接治理 MCP server 后的 Host 快照。
- `governance://dashboard/elements`：页面所有可引用元素的索引。
- `governance://workpacks` / `governance://issues` / `governance://artifacts`：结构化治理资源。
- `governance://workpack/<id>` / `governance://issue/<id>` / `governance://artifact/<id>` / `governance://tool/<name>` / `governance://prompt/<name>` / `governance://source/<path>`：单个页面元素。

支持 MCP 的客户端可按 `tools/skill_workflow_governance/README.md` 配置 `gamedraft-governance` server。只读治理分析不改文件；执行修复时只改被选治理包/证据指向的文件，完成后必须重新 audit。

## §0 先分类，再动手

判断这次改动会不会改变玩家可见的规则 / 结果 / 资源流 / 进度 / 玩法体验，据此选规则：

- **做内容 / 只改 JSON**（任务、支线、对话、遭遇、规矩、物品、商店、演出、场景交互、档案、地图、小游戏、文案）→ 进**策划模式**（§2），代码默认只读。
- **不改玩法的技术改动**（重构、架构修复、性能、UI 实现细化、工具、修 bug）→ 遵守**代码侧铁律**（§1），按 feature-iteration 流程，最小必要改动。
- **改编辑器 / 策划工具**（`tools/editor`、`tools/*_editor` 等 PyQt 桌面工具）→ 在 §1 之外，额外遵守**编辑器开发约束**（§3）。
- **会改变玩法设计含义**（需要先更新玩法文档、做设计取舍）→ 先按 gameplay-iteration 审查玩法一致性：先改 `docs/玩法功能需求清单.md`，冲突先停下报告，再动代码。
- **全项目架构盘点** → core-framework-architecture-review：只输出问题清单存 `artifact/Reviews/`，默认不修，等"开始修复"。

拿不准先判类型，不要直接实现。任何一类都不要把小需求扩成大重构。

## §1 改代码时 — 8 条架构铁律

对照 `docs/游戏架构设计文档.md`，违反任一条先停下报告：

1. **分层依赖**：UI→系统→渲染→核心→数据，下层不反向依赖上层（唯一例外是 `Game.ts` 组装层）。
2. **系统解耦**：同层 system 默认只经 EventBus / FlagStore 通信，不互持引用（少数已知受控例外，见架构审计，不要再新增）。
3. **依赖注入**：构造函数注入依赖，禁全局单例 / 跨模块直接 import 其它系统实例。
4. **数据驱动**：内容（物件名 / 规矩名 / NPC / 任务 ID / 对话文本）一律走数据文件，代码不硬编码。
5. **统一条件源**：运行时布尔/数值状态以 FlagStore 为唯一存储；广义条件统一走 `evaluateGraphCondition`，不另写一套运算符。
6. **统一动作执行**：一切游戏行为经 `ActionExecutor`，不在各系统内硬编码动作处理。
7. **统一接口**：系统实现 `IGameSystem`（init/update/serialize/deserialize/destroy）。
8. **完整生命周期**：`destroy()` 不留残留（监听/定时器/渲染对象/缓存），重 `init()` 行为与首次一致。

工程：TS 严格模式，收尾 `npx tsc --noEmit`；测试用 Vitest（`npm test`），**迭代时不主动新增独立测试**；结束做局部回归 review，发现问题先修再结束。

## §2 做内容时 — 策划模式

完整规则见 `.cursor/skills/production-mode/SKILL.md`；字段级"可编辑内容地图"见 `docs/editor-authoring-surface.md`。

**三红线**
1. **代码默认只读、只写 JSON**。唯一允许的代码改动是 L2 升级（为打通数据需求新增能力原语）。
2. **写不出来就升级 / 上报，不糊弄**：不偷改业务代码绕过机制、不用假数据/空实现敷衍、不把动作硬塞到不该去的结构。
3. **JSON 必须保持"编辑器可往返"**：agent 直接改 JSON，但人类仍只通过编辑器维护 JSON。

**机制铁律**（绕过的写法运行时被静默跳过或编辑器拒绝保存）
- 游戏行为全走 command（`ACTION_TYPES` 为权威清单）。
- 成段演出（有时序/相机/淡入淡出/并行）全走 cutscene；cutscene 内**禁改存档**、只用白名单 action。单发反馈（showEmote/playScriptedDialogue/playNpcAnimation）可作普通 command。
- 条件走 5 类叶子（flag / quest / scenario / scenarioLine / narrative）+ all/any/not。
- 对话分支走图对话 graph JSON；玩家可见文本走 `[tag:…]`。

**升级三级阶梯**
- **L1 纯数据可达** → 直接在 JSON 实现。
- **L2 缺能力原语**（新 command / 缺参数 / 新 present 类型 / 新条件叶子 / 新图节点）→ 自动切代码模式，按 add-game-action 三件套（运行时 `register` + 编辑器 `ACTION_TYPES`/`_PARAM_SCHEMAS` + `validator` 认可）最小新增，跑 `tsc` + 校验，**完成后告知用户改了哪个原语/哪些文件**。
- **L3 连新增也撑不住**（新子系统 / 运行时算术 / 集合寻址）→ 不硬做，跳过该任务，**最后统一汇报所有被跳过的任务**。

**编辑器往返硬契约**
- 格式：`ensure_ascii=False` + 2 空格缩进 + 末尾换行 + 中文不转义 + 不排序键。
- 只改编辑器管理的文件；别碰 `anim.json`（编辑器只读）、`.ink`、`public/resources/runtime/**` 媒体。
- `[tag:…]` 与跨文件 ID 引用必须有效，否则编辑器保存直接 `raise`、整工程存不了。
- **重建区**（编辑器 Apply 整体重建、塞自定义字段会被抹）：`hotspot.data`（尤其 inspect 的 `data.text` 会被丢——想"看一眼弹正文"用 actions 或 graphId）、`npc.patrol`、`spawnPoint`、被编辑过的对话节点、`scenario.phase.outcome`、已知 cutscene present 步、音频条目、`item.dynamicDescriptions`。
- **盲区即升级信号**（运行时支持但 GUI 改不到）：`changeScene.cameraX/cameraY`、`flag_registry.migrations/runtime`、扎纸小游戏多数高级字段、非档案富文本的 `[img:…]`——落到这里按 L2 升级或上报，不要闷头写人类维护不了的 JSON。
- **别写 deprecated 字段**（编辑器会主动删）：`quest.nextQuestId`、`rule` 旧 `verified/description/source`、`zone.x/y/width/height/ruleSlots`、`npc.dialogueFile/dialogueKnot`、cutscene 旧 `commands`。

**收尾校验**（每次改完 JSON 必做，迭代到通过）
1. 素材存在性：`python -m tools.editor.shared.asset_reference_audit . --strict`
2. 全量数据校验：`./dev.sh validate-data`（`-- --strict` 让 warning 也算失败）
3. 校验抓不到、要自己当心的：对话图内部 `next` 连边、素材文件存在性、大量引用只 warning——**不能"没 error 就当对了"**。

## §3 改编辑器 / 策划工具时（tools/editor 等 PyQt）

这是 feature-iteration 的一种（仍守 §1）；完整见 `.cursor/skills/editor-tools-iteration/SKILL.md`。

**结构化代码，不准乱写**
- 复用既有骨架，别临时堆控件、别把 UI 逻辑散在槽函数里：面板沿用「主从列表 + 详情」样板（`_refresh` / `_on_select` / `_apply`）；候选项一律取自 `ProjectModel` 的 id-provider（`all_scene_ids` / `all_item_ids` / `npc_ids_for_scene` / `spawn_point_keys_for_scene` / `animation_state_names_for_actor` …）；新编辑器接入要在 `main_window.py` 注册 + 在 `project_model.py` 对齐 load / save / `mark_dirty` 的命名 dirty 桶。
- 先判断编辑模式（主从列表 / 单表 / 动作列表…）对齐同类编辑器，不造一次性写法。

**GUI 要好用、布局合理**
- 按数据域分组（QGroupBox / Tab / Splitter）；复杂块用折叠且**默认折叠**；短 id / 枚举 / 数字框别 stretch 拉满整行，长文本 / 路径才占宽行；按钮用短标签 + tooltip，别整行铺满或纵向堆长句；说明进 tooltip，不在界面堆大段文字。
- 可编辑列表按需补：上移 / 下移（顺序要写进 JSON 时**必须**）、删除、右键菜单。

**非自由文本字段必须用选择器（核心）**
凡是可枚举 / 引用 / 映射 / 受约束的值——**id、场景、出生点、位置坐标、flag、物品、规矩、任务、动画状态、枚举、颜色、资源路径**等——一律用现成选择器，**禁止裸 `QLineEdit` 让人手打**：

| 字段类型 | 用这个控件 |
|---|---|
| id 引用（scene/item/quest/rule/cutscene/npc…） | `IdRefSelector` / `_make_id_selector(kind=…)` |
| 枚举 / 已登记类型（动画 state、Action 子类型） | `FilterableTypeCombo(select_only)` |
| flag 键 / 值 | `FlagKeyPickField` + `FlagValueEdit` |
| 条件 / 动作 | `ConditionEditor` / `ActionEditor` |
| 位置、坐标、途经点 | 地图点选（`MoveEntityToMapPickerDialog` / 场景预览拾取），不手输坐标 |
| 出生点 | 只读框 + "选择出生点…" 在场景预览点选 |
| 图片 / 资源路径 | `CutsceneImagePathRow`（Browse，自动入 `runtime/`） |
| 颜色 | 取色器（`HexColorPickRow`） |
| 含 `[tag:…]` 的玩家可见文本 | `RichTextLineEdit` / `RichTextTextEdit` |

- **区分"定义自身 id"与"引用他者 id"**：给新实体命名自己的 id 用裸 `QLineEdit` 合理；**引用已存在的他者**（scene / item / 对话图节点 / spawn / 位置…）必须用选择器。
- `QLineEdit` 只留给真正的自由文案（描述、台词、JSON 专家模式）。

**收尾自检**：UI→`mark_dirty`→写盘路径完整；不在错误时机 sync 清空字段；与磁盘 schema 兼容；新增字段同步 `validator.py`；横向检查共用 `ProjectModel` 的其它编辑器是否受影响。

## 详细规则文件（按需展开）

- 代码侧：`.cursor/skills/feature-iteration/`、`gameplay-iteration/`、`core-framework-architecture-review/`、`docs/游戏架构设计文档.md`
- 内容侧：`.cursor/skills/production-mode/`、`pure-data-iteration/`、`docs/editor-authoring-surface.md`、`docs/玩法功能需求清单.md`
- 扩展能力：加 Action `.cursor/skills/add-game-action/`；加文本引用 `.cursor/skills/add-text-ref/`
