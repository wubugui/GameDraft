# GameDraft — Claude 工作规则

> 本文件每次会话自动载入,定位是**路由器**:判定任务类型 → 指到那一域的权威规范。
> 规则正文在 `agent_docs/<域>/norms.md`,不在这里——同一条规则只维护一处
> (2026-08-05 治理 run 收敛,原 §1/§2/§3 正文已全部并入库内 norms,本文件曾列的
> 「重建区八项」已过期,以库内 `editor-roundtrip-contract` 为准)。
>
> **列举型内容一律以代码为准**:Action 清单查 `tools/editor/shared/action_editor.py` 的
> `ACTION_TYPES`,游戏状态查 `src/data/types.ts` 的 `GameState`,条件叶子查
> `src/systems/graphDialogue/evaluateGraphCondition.ts`。架构文档
> (`docs/游戏架构设计文档.md`)里的清单会漂,不要照抄任何文档里的表。
>
> **光影是「原画 + 加性实体灯」**(2026-08-30 制作人定调,取代 08-20 的统一光影重打光):**原画就是最终的光照**,运行时不重新照亮场景,只把作者摆的实体灯加上去(灯**乘在一张烘出来的 albedo 贴图**上 —— 2026-09-07 起不再是 shader 里现除的 `原画/S_day`,那张图**作者可以手改**,全时段共用主背景那一份)。**「夜」靠换一张夜原画**(`timeVariants` 整套时段外观)+ 该时段的 probe + 该时段的灯,不靠调暗天光——天光与太阳的**运行时加光项已删**。角色一律走 probe 底光 + 与场景**同一次打包**的加性灯。⚠ 统一角色路径已被 `Game.UNIFIED_CHAR_PATH_ENABLED = false` 整条关死,`UnifiedCharacterShader` / GI 反弹 / 3D 天穹可见性网格 / `lighting.placeholder` / `radianceScale` **全部无消费者**(留码不删,读代码别被它们误导;`placeholder` 尤其不能再拿来判断"这个场景走哪条")。正文见 `agent_docs/runtime/mechanisms/scene-lighting.md`。
>
> **光照烘焙只有一个工具、一个目录**(制作人 2026-08-31 收束):`tools/character_lighting_lab` 产出一张背景图的**全部**派生物(深度/标定/probe/体素/行走面 + 法线/天穹可见性/**albedo 贴图**),统一落 `runtime/scenes/<id>/lighting/<背景基名>/`。烘几何场:`sh scripts/py.sh -m tools.character_lighting_lab.scene_fields --scene <id>`;只补 albedo 加 `--albedo-only`(不重跑任何 march)。⚠ 别再另起 baker 或另开目录——同一份东西分两处放,打包规则/校验器/审计各写一套路径,少写一层就是**整批静默失效**(已发生过四次)。
>
> **🔴 铁律 0 · 光照一律在世界空间算**(制作人 2026-08-30 定死,无例外):
> **所有的光照必须在世界空间计算;任何 q 空间的量都必须先转换到世界空间,再参与光照计算。**
> 法线、灯位、灯的方向、`N·L`、`1/r²` —— 进 `lc*Light` 之前必须已在 M-world。
> 混用**一律不报错**,只是画面不对:实测场景侧曾拿 q 空间法线配 M-world 灯位,
> 灯正下方 `N·L` 恒为 0,一盏灯只剩不走 N·L 的光晕看得见(白饼里站个黑人)。
> 正文、落地清单、当前欠账、验收判据全在
> `agent_docs/runtime/mechanisms/coordinate-spaces.md` 的「铁律 0」一节。

<!-- agent-docs-gate:begin (由 agent_docs/_meta/cli.py install 维护,勿手改) -->
## §A 开工先查公共知识库(agent_docs)

- 动手前按任务域读 `agent_docs/INDEX.md` 对应条目;确定要改的文件后跑
  `sh scripts/py.sh agent_docs/_meta/audit.py --paths <files...>` 取必读机制卡,先读卡再动手。
- 治理类业务(治理/建库/收编方法论/炼化/intake)统一入口:`sh scripts/py.sh agent_docs/_meta/cli.py`。
  (py.sh = 跨平台 python 选择器;部分 Windows 机上 python3 是 Store stub 会静默空转)
- 发现库内文档与现实打架:收尾往 `agent_docs/_meta/inbox/` 丢一条三行偏差记录(零门槛)。
<!-- agent-docs-gate:end -->

## §H `handbook/` 是制作人的手册,agent 不得擅写

`handbook/docs/*.md` 是制作人**自己维护、自己看**的文档站(与 `agent_docs/` 无关——那是 agent 自己维护
自己看的库,两边互不搬运)。agent **只在制作人明确要求时、按其指定的内容**写入;不主动新增、不整理、
不同步、不生成、不把 agent_docs 的东西搬进去——制作人没要的每一个字都是他阅读时的噪音。
agent_docs 治理与索引一律不触碰该目录。**往里写一律走 `handbook-mode` 技能(文档模式)**:只写他说的、
拿不准就问、结构由 agent 规划先过目。开站:`sh scripts/py.sh -m tools.handbook`(console / 主编辑器 F1 同一入口)。

## §0 先分类,再动手

先判断这次改动**会不会改变玩家可见的规则 / 结果 / 资源流 / 进度 / 玩法体验**,按下表选规则。
拿不准先判类型,不要直接实现;任何一类都不把小需求扩成大重构。

| 这次要做什么 | 权威规范(正文在这) | 这一类最贵的一脚 |
|---|---|---|
| 做内容 / 只改 JSON(任务、对话、遭遇、规矩、物品、演出、场景交互、档案、小游戏、文案) | `agent_docs/content/norms.md` | 通道外的写法运行时被**静默跳过**、或编辑器拒存 |
| 不改玩法的技术改动(重构、架构修复、性能、UI 实现、工具、修 bug) | `agent_docs/runtime/norms.md` | 分层反向依赖;`destroy` 留残留 |
| 改编辑器 / 策划工具(`tools/editor`、`tools/*_editor` 等 PyQt) | 叠加 `agent_docs/editor-tools/norms.md` | 裸 `QLineEdit` 承载引用字段;绕过统一写盘出口 |
| 产素材(抠图、动画、立绘、配音、音效、视差) | `agent_docs/asset-pipeline/norms.md` | 重扣源 ≠ 游戏当前实际源 |
| 改光影(场景灯光、夜景、雾、角色受光、阴影) | `agent_docs/runtime/mechanisms/scene-lighting.md` + `character-lighting.md` + `entity-lighting.md` | 照着**已停用**的统一光影那套改(重打光 / placeholder / 角色吃天光) |
| 跨域 / 拿不准 / 系统设计 | `agent_docs/meta/norms.md` | 四个存放面混放 |

两个例外流程:

- **会改变玩法设计含义** → 先改 `docs/玩法功能需求清单.md` 对齐,**冲突先停下报告**,再动实现。
- **全项目架构盘点** → core-framework-architecture-review:只输出问题清单存 `artifact/Reviews/`,
  默认不修,等"开始修复"。

## §G Skill / Workflow 治理台入口

做 skill / workflow 治理、治理包拆分、agent 任务分发时,不靠 dashboard 截图或页面肉眼信息判断,
先刷新并取结构化上下文:

```bash
sh scripts/py.sh -B tools/skill_workflow_governance/govern.py audit
```

产物在 `tools/skill_workflow_governance/out/`(`agent-context-current.md` = 给 agent 直读的便携包,
`registry.json` = 完整机器可读状态);MCP server 配置与 `governance://` 资源清单见同目录 README。
只读治理分析不改文件;执行修复只改被选治理包/证据指向的文件,完成后必须重新 audit。

## §S 流程壳(怎么做)

`.cursor/skills/` 与 `.claude/skills/`:feature-iteration、gameplay-iteration、production-mode、
pure-data-iteration、editor-tools-iteration、add-game-action、add-text-ref、
core-framework-architecture-review、agent-docs-cli、**handbook-mode**(文档模式:往制作人手册写东西,见 §H)。

**壳只留"怎么做",知识("是什么/为什么")一律在 agent_docs**——两边打架时以库为准。
