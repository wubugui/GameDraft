# json_lang —「JSON=语言」工具链(第一块:schema 索引器)

把项目数据 JSON 当作一门语言对待:运行时是解释器、编辑器是可视化 IDE、JSON 是源码。
本工具是这门语言的 **IDE 索引器**:启动时从权威代码 + 真实数据现场重算一份
JSON Schema,VS Code / Cursor 消费它,直接获得——

- 动作 `type` / 参数结构 / **必填参数** 校验(权威:`actionParamManifest.ts`)
- 条件表达式语法校验(6 叶 + all/any/not,权威:`evaluateGraphCondition.ts`)
- **ID 引用烤入真实枚举**:物品/任务/场景/出生点/NPC/flag 键/过场/小游戏/对话图/
  档案条目/音频/气味/位面/信号…… typo 与悬垂引用在编辑器里当场黄线,
  且枚举即自动补全候选。
- **跨字段收窄**(SCOPED_PARAM_RULES 生成 if/then):场景→出生点/zone/hotspot/实体、
  `addArchiveEntry` 的 bookType→条目——"选了场景 A 却填场景 B 的出生点"当场报。
- **枚举中文旁注**(enumDescriptions):补全 id 时旁边直接显示「铜钱」「茶馆」「玩家(魔法名)」。
- **补全脚手架**(defaultSnippets):在动作数组(实证发现的 actions/onEnter/onComplete…
  宿主键)按补全,一键插入带必填参数占位的完整 action;条件宿主一键插入六类叶子模板。

- **叙事叶静态收窄**:`narrative` 图 id 枚举(定义处=narrative_graphs 的 mainGraph+
  elements[].graph,35 张)+ 图确定时 `state` 收窄到该图声明的 states——悬垂叙事引用
  (改名/删状态后的条件恒 false)从"运行时 dev 红条"前移到打字当场;`@owner`/`@scene`
  相对 token 与模板占位(`{{…}}`)走 pattern 分支不误报。`scenarioLine` 枚举
  scenarios.json id;`scenario` 确定时 `phase` 收窄到其声明的 phases。

另有 `--lint`(schema 之外的图级检查,专抓 CLAUDE.md 明说"校验抓不到"的对话图连边):
悬垂连边 / **悬垂外部入口**(npc.dialogueGraphEntry、hotspot 与 startDialogueGraph 的
graphId+entry,跨文件)= error;entry+全部外部入口出发不可达的节点 = warning
(共享图如 街巷_市井闲谈 一图 18 入口,按运行时通道建模,不误报)。

以及 `refs.py`(find-all-references 命令行版,零插件):

```bash
python3 tools/json_lang/refs.py copper_coins          # 值/键/[tag:] 三路匹配
python3 tools/json_lang/refs.py from_dock --json      # 结构化输出给 agent/脚本
```

输出带 id 宇宙归属、中文名、疑似定义处标记(★)。只查不改——要迁移/改名/删除,
走 `entity_refactor` 引擎(agent_docs: entity-refactor-engine)。

**刻意不做:信号生产-消费对账**。已有权威机制(`narrative_catalog.emitted_signal_ids`
实发四源口径 + validator 悬垂监听 warning + 叙事编辑器 TaskBusPanel,含已知噪声语义,
见 agent_docs: emitted-signal-catalog)——再造一套即第四份拷贝,违反本工具第 4 条铁律。

## LSP:常驻语言大脑(`lsp_server.py`)

标准 LSP server(纯 stdlib、stdio 传输),定位是**语言大脑服务**——今天服务 IDE,
将来 PyQt 编辑器的 id 候选/引用扫描可改为问它(那一步要动编辑器本体,单独拍板):

- `textDocument/definition` Cmd+点击 id 跳定义(items 条目/场景文件/图文件/flag 登记…;
  与 workspace/symbol 共用单遍全扫的定义索引)
- `textDocument/references` Shift+F12 全项目引用(与 refs.py 同口径)
- `textDocument/hover` id 卡片(中文名/宇宙/定义处/引用数);action 类型出必填/可选参数表
- `workspace/symbol` Cmd+T 按 id **或中文名**搜实体/图/任务/物品,直接跳定义
- **overlay**:didOpen/didChange 推送的未保存内容参与一切查询,**含 id 宇宙本身**
  (未保存的新物品立即进 hover/candidates)——"编辑器可依赖"的前提
  (编辑器内存态≠磁盘态,大脑必须能看见前者),已用脚本会话验证
- **watch 已并入**:server 存活期间后台线程盯磁盘数据,变化后自动重产 out/ 的 schema;
  `.vscode/tasks.json` 的 folderOpen 任务退化为开窗一次性刷新(无扩展环境的兜底),
  `build.py --watch` 保留给无编辑器场景
- 自定义方法(编辑器接入面 + agent 脚本可直接调):
  `gamedraft/universes`(宇宙概览)、`gamedraft/candidates {universe}`(id 选择器候选源,
  对位 ProjectModel 的 id-provider)、`gamedraft/refs {id}`(结构化引用+精确位置)、
  `gamedraft/search {query, ignoreCase?, limit?, scope?}`(全文子串搜索:值/键/数字
  整树匹配,命中带 pointer/context/excerpt/anchors/line;scope 简写
  data/scenes/dialogues/narrative/cutscenes 或任意路径前缀;PyQt 主编辑器「全局搜索」
  对话框的后端;命令行版 `python3 tools/json_lang/search.py <query>`)、
  `gamedraft/status`(server 自述:文件数/overlay 数/宇宙规模;主编辑器状态栏用)

**安装(唯一手动步骤,一台机器一次)**:

```bash
sh tools/json_lang/vscode-ext/install.sh   # 符号链接进 ~/.vscode 与 ~/.cursor 的扩展目录
# 然后在 VS Code/Cursor 里 Developer: Reload Window
```

客户端(`vscode-ext/`)是零依赖薄扩展:手写 Content-Length 框架层 + 三个 provider,
无 npm、无构建;server 侧是标准 LSP,换任何支持 LSP 的编辑器都能接。卸载=删符号链接。

**F2 改名(textDocument/rename,2026-07-13 落地)**:span 级 WorkspaceEdit(编辑器内
应用、可撤销、不重写文件格式)。**安全宇宙白名单**(物品/任务/规矩/遭遇/商店/长按/
信号Cue/文档揭示/气味/位面/flag静态键/档案条目/scenario/信号/音频键/过场 id);
实体/出生点拒绝并指路 entity_refactor,场景/对话图/小游戏(文件名耦合)与叙事图
(派生广播信号字符串)拒绝;值恰好等于 id 的展示文案键(text/name/itemName…)不改;
命中 [tag:] 段内引用整体放弃。新名撞车拦截。改完跑 `./dev.sh validate-data` 兜底。

**编辑器接入(2026-07-13 落地,tools/editor/shared/lsp_client.py)**:
- **overlay 发布者**:`mark_dirty` 防抖 800ms 后,内存态按 `overlay_payloads` 镜像表
  (对应 save_all 写盘分支;新增脏桶时补一行)推成 didChange——**编辑器未保存的内容,
  IDE 悬停/补全/查引用与 agent 查询实时可见**;Save All 成功后 clear_overlays 回落磁盘。
- **查引用消费者**:主编辑器 Tools → 「查引用(JSON 语言)」,全宇宙 id 三路匹配。
- 决策:id-provider 候选**保持本地实现**(编辑器内存态本就是它自己下拉框的最新真相,
  经 socket 绕一圈无意义;LSP 候选面向的是 IDE/agent 等外部消费者)。
- server 缺席/启动失败全链路静默降级;pytest 环境自动不拉子进程。

**去所有权化(部分落地,2026-07-13)**:重建区"未知键透传"模式
(`tools/editor/shared/rebuild_merge.py`):`hotspot.data`(五类型,含著名的 inspect
`data.text` 丢失)与 `spawnPoint` 已改为保留未知键(managed=面板编辑键并集,清空的
字段不复活、换类型旧键仍清理);侦察发现音频条目与 `npc.patrol` **本来就保留**
(契约卡过时)。仍是重建区的:被编辑的对话图节点、cutscene present 步(各有独立契约
与专属测试,单独治理)、`item.dynamicDescriptions`(条目无稳定身份,无法安全合并)、
`scenario.phase`(未处理)。

## 设计铁律

1. **方向永远是 代码→schema**。`out/` 是派生缓存(不入库、`.gitignore`),权威仍在
   运行时 TS 与编辑器 Python(CLAUDE.md「列举型以代码为准」)。schema 与本体不一致
   =重跑生成器,绝不手改 schema。
2. **常驻 watch,无对账门**(IDE 建索引模型):`.vscode/tasks.json` 在 folderOpen 挂起
   `build.py --watch`——纯 stdlib mtime 轮询(默认 2s,数据文件+五个权威源都盯),
   变化后等指纹稳定(编辑器 save_all 是一波连写)再全量重算;0.25s 的全量重算就是
   最好的增量策略。半写/坏 JSON 不会杀死 watcher,恢复后自愈;schema 内容没变不重写、
   写盘走原子替换。IDE 开十天半个月,agent/编辑器改的 JSON 几秒内枚举自动跟上。
3. **零侵入**:纯 stdlib、只读。Python 权威用 `ast` 静态解析(不 import,避免 Qt 副作用),
   TS 权威文本解析。对运行时/编辑器/校验门无任何影响,爆炸半径=IDE 里的波浪线。
4. **结构无关深扫描**:不建模文档结构(避免成为 validator.py 的第四份拷贝)。
   凭签名识别语言构造:`{type, params}`=action(全项目侦察确认零歧义);
   键名匹配 `*[cC]ondition(s)?`=条件宿主。
5. **宁可少校验,不误报**:空宇宙不注入枚举;`str` 参数不约束类型;
   可选引用允许空串(编辑器"未填"写法);跨字段限定(spawn 属于哪个 scene、
   bookType 限定 entryId)做不到就放全局并集。

## 权威源(读哪些、抽什么)

| 权威 | 抽取物 |
|---|---|
| `src/core/actionParamManifest.ts` | 各 action 的 required/optional(参数必填唯一权威) |
| `tools/editor/shared/action_editor.py` | `ACTION_TYPES`(类型枚举)、`_PARAM_SCHEMAS`(参数原始类型) |
| `tools/editor/shared/entity_refactor.py` | `ENTITY_REF_PARAMS`(哪个参数是实体/场景/出生点引用) |
| `src/systems/graphDialogue/evaluateGraphCondition.ts` | 条件叶子清单(`ConditionTrace` kind 联合)、枚举字面量 |
| `src/data/types.ts` | flag 条件 `op` 联合 |
| `public/assets/**` 数据现场 | 31 个 id 宇宙(定义处收集,含 `cutsceneSpawnActor` 定义的临时演员) |

权威源形状变化时提取器直接 raise;权威之间打架/出现新条件叶子或新 ref kind 时出
tripwire WARNING(`--check` 可让其变非零退出码)。

## 用法

```bash
python3 tools/json_lang/build.py              # 重算一次
python3 tools/json_lang/build.py --watch      # 常驻自动刷新(folderOpen 任务就是它)
python3 tools/json_lang/build.py --validate   # 顺带把全部数据文件过一遍 schema,列违例
python3 tools/json_lang/build.py --lint       # 对话图连边 lint(悬垂=error → 退出码 1)
python3 tools/json_lang/build.py --check      # tripwire warning → 退出码 1
```

`--validate` 需要 `jsonschema` 包(`.tools/venv` 里有:`.tools/venv/bin/python …`)。

## 与既有校验门的关系

不替代任何一道门:validator / 编辑器保存门仍是权威裁决。本工具是**编辑时前移**
的咨询层,抓的是"打字那一刻"的 typo/悬垂引用/缺必填。

**已并入收尾门**(2026-07-13):`./dev.sh validate-data` 会在 validator 之后追加
json_lang 检查——schema 全量违例记 **warning**(`--strict` 升级为失败)、对话图悬垂
连边/悬垂外部入口记 **error**、不可达节点记 warning;json_lang 自身故障降级为一条
warning,不拦内容工作。直接访问:`./dev.sh json-lang -- --validate --lint`。
曾经的"校验抓不到"盲区(对话图 next 连边、未登记 flag 引用)自此有机器看守。

## 已知天花板(按设计接受)

- 跨字段收窄只覆盖登记进 `SCOPED_PARAM_RULES` 的动作参数配对与条件叶的
  narrative→state / scenario→phase;`setEntityField.fieldName`、scenario 叶的
  `status` 取值仍不枚举(权威不可静态枚举)。
- `[tag:…]` 字符串内部引用只由既有编辑器保存门管,schema 不管。
- `owner` 引用(种类由同 action 的 ownerType 决定)不校验。
- 后续阶梯(未做):跨文件 goto-definition / rename 的薄 LSP(可复用
  `entity_refactor.py` 的索引);编辑器去所有权化(重建区不抹字段)——最贵,单独拍板。
