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
> **光影现在有新旧两套并存**(2026-08-23):场景配了 `lighting` 块的走统一光影(`src/rendering/lighting/`),没配的走旧的 `lightEnv`/probe。28 个场景已全部接进新管线,**恒等占位那套(`placeholder`)已删除** —— 现在默认状态是 `lighting.gi = 1`(吃烘焙 GI,画面精确等于原画),角色走完整同一条链、不再被挡在门外。重打光 = 把 `gi` 调低 + 加天光/灯。判断某个场景重打光到什么程度,看 `gi` 与 `sky.intensity`。

<!-- agent-docs-gate:begin (由 agent_docs/_meta/cli.py install 维护,勿手改) -->
## §A 开工先查公共知识库(agent_docs)

- 动手前按任务域读 `agent_docs/INDEX.md` 对应条目;确定要改的文件后跑
  `sh scripts/py.sh agent_docs/_meta/audit.py --paths <files...>` 取必读机制卡,先读卡再动手。
- 治理类业务(治理/建库/收编方法论/炼化/intake)统一入口:`sh scripts/py.sh agent_docs/_meta/cli.py`。
  (py.sh = 跨平台 python 选择器;部分 Windows 机上 python3 是 Store stub 会静默空转)
- 发现库内文档与现实打架:收尾往 `agent_docs/_meta/inbox/` 丢一条三行偏差记录(零门槛)。
<!-- agent-docs-gate:end -->

## §0 先分类,再动手

先判断这次改动**会不会改变玩家可见的规则 / 结果 / 资源流 / 进度 / 玩法体验**,按下表选规则。
拿不准先判类型,不要直接实现;任何一类都不把小需求扩成大重构。

| 这次要做什么 | 权威规范(正文在这) | 这一类最贵的一脚 |
|---|---|---|
| 做内容 / 只改 JSON(任务、对话、遭遇、规矩、物品、演出、场景交互、档案、小游戏、文案) | `agent_docs/content/norms.md` | 通道外的写法运行时被**静默跳过**、或编辑器拒存 |
| 不改玩法的技术改动(重构、架构修复、性能、UI 实现、工具、修 bug) | `agent_docs/runtime/norms.md` | 分层反向依赖;`destroy` 留残留 |
| 改编辑器 / 策划工具(`tools/editor`、`tools/*_editor` 等 PyQt) | 叠加 `agent_docs/editor-tools/norms.md` | 裸 `QLineEdit` 承载引用字段;绕过统一写盘出口 |
| 产素材(抠图、动画、立绘、配音、音效、视差) | `agent_docs/asset-pipeline/norms.md` | 重扣源 ≠ 游戏当前实际源 |
| 改光影(场景重打光、灯、雾、角色受光、阴影) | `agent_docs/runtime/mechanisms/character-lighting.md` + `entity-lighting.md` | 用**旧的** probe/lightEnv 那套去改新场景 |
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
core-framework-architecture-review、agent-docs-cli。

**壳只留"怎么做",知识("是什么/为什么")一律在 agent_docs**——两边打架时以库为准。
