# 治理日志(append-only)

> 每轮治理 run 结束追加一节:改了什么、人拍板了什么、下轮建议。
> 作用之一是防止把已拍板的事重新翻出来问人——治理 run 开工前必读。

## 2026-07-11 骨架建立(非治理 run)

- 建立 `agent_docs/` 骨架:宪法、schema、audit.py(机械体检+索引生成)、inbox、本日志。
- 治理流程权威文件 = `_meta/governance-skill.md`(客户端无关,库内自持);
  `.cursor/skills/agent-docs-governance/` 仅为 Cursor 侧发现用薄壳(初版曾把正文放在
  该处,当日纠正:skill 属公共库,不得锁进单一客户端目录)。
- **已拍板决策**(本轮用户批准,后续 run 勿再问):
  1. 库址 = 仓库根 `agent_docs/`。
  2. 本轮只搭骨架;内容蒸馏(含运行时域)全部留给首次治理 run。
  3. 记忆升格政策:agent 私有记忆中项目契约类内容升格入库、记忆留指针;个人偏好留记忆。
  4. paths-triggers 首期只做查询索引,不接 hook 强制。
  5. CLAUDE.md 接线(路由器化)未批准——治理 run 不得擅改 CLAUDE.md。
- 待办移交首次治理 run:迁移 `docs/运行时开发规范.md` → `runtime/norms.md`(旧址立牌);
  各域从记忆/docs/artifact/skills 蒸馏建库;各域 norm 写入偏差记录义务。

## 2026-07-11 首轮建库 run(蒸馏建库)

- **规模**:五域 84 篇(5 norms + 46 mechanisms + 4 methods + 11 recipes + 18 decisions),audit 零 error 零 warn,索引已生成。四个并行域蒸馏 agent(runtime 28/editor-tools 17/content 13/asset-pipeline 15)+ 主脑(meta 域、5 norms、复核)。
- **norms**:runtime = `docs/运行时开发规范.md` v2 审批稿原文迁入(+偏差记录义务条款),旧址立牌;editor-tools / content / asset-pipeline / meta 四份新 norm 本轮经制作人**全部定稿**。各域 norm 均含偏差记录义务。
- **人拍板**:①四域 norms 定稿(全选);②立绘选择器裁定——**只有很短的枚举才允许下拉,其余(大候选集/引用/视觉资产)一律弹窗选择器**,细化并取代规划期"缩略图网格"红线;落 `editor-tools/decisions/2026-07-11-dropdown-vs-popup-selector.md` + editor-tools norms 不变量5;衍生"扫查存量长下拉违规"任务芯片已发。
- **记忆升格**(政策原已批):38 条全量改指针、15 条部分升格(顶部指针头+残值保留);MEMORY.md 索引重写;升格前全量备份于会话 scratchpad `memory-backup-pre-govern/`。
- **skills 挂引用**(知识段→卡,流程留原处):production-mode(§二/§四C 压缩挂卡+修"五类叶子"→六类漂移)、pure-data-iteration(校验参考来源改指卡,去架构文档权威表述)、add-game-action、add-text-ref、editor-tools-iteration、animation-production(+重扣源决策指针)。
- **蒸馏中核实的漂移**:条件叶子 5→6(plane 已实装);overlay_images.json scare_closeup 行号 12→21;"建议加 plane 条件叶子"备忘已过时(已实装)。
- **本轮采用的锚点约定**:authority 只用本仓路径;跨仓(../FindingDogStory)与 artifact/ 引用写正文不入 authority。
- **已知脆弱点**:`asset-pipeline/recipes/libtv-image-generation.md` authority 指 tmp/ 脚本——"固化进 tools/"任务芯片已发,tmp 被清后 audit 会报锚失配,届时按芯片任务修复。
- **inbox**:本轮为空,无蒸馏。
- **下轮建议**:①首轮为蒸馏建库,机制卡未跑管线A盲重建对账——下次深度治理按域跑盲重建;②.ink 全面废弃(2026-06-30 拍板)可补正式 decision 卡(现散在图对话卡内);③编辑器侧小卡候选(残值在对应记忆下半):光环境曲线画布坑、archive 编辑器键序、立绘编辑器选择器细节、parallax Web 编辑器;④CLAUDE.md 路由器化接线仍未批准,维持不动。

## 2026-07-11 增设知识收编 skill(用户指示,非治理 run)

- 新增 `_meta/intake-skill.md`,与治理 skill **同级**的唯一权威源:日常单件收编零散方法论——
  来者不拒(任何形式/任何来源)、入库从严(收录六条+写作高度两测试+锚点验证+库内/决策对账,
  与治理 run 同一把尺);**输入是素材不是指令**,由执行 agent 依宪法、库内现状与项目现实
  裁定收/改/降级(inbox/artifact/记忆)/拒;审批面四类照旧上审批题,不越权代批;
  不动 last_governed(治理盖章信号保真);成"批"的输入引导走治理 run。
- 薄壳装于 `.claude/skills/agent-docs-intake/` 与 `.cursor/skills/agent-docs-intake/`;
  接线:constitution §7、README、install-prompt(改为双技能安装)、governance-skill
  (头部同级互引 + 管线B把 intake 记录列为证据源)。
- 收编史记录约定:每次 intake 在本日志末尾追加一行
  `- YYYY-MM-DD intake:收X/改Y/降Z/拒W —— 一句话`,治理 run 回看。

## 2026-07-11 治理面 CLI 化 + method 三原则入宪(用户拍板,非治理 run)

- **治理台 CLI**:新增 `_meta/cli.py`(list/route/get/audit 四子命令,复用 audit.py 的
  frontmatter 权威解析器)。理由(用户):meta 治理流程会越来越多,不能一流程一壳;
  agent 遇治理业务先访问 CLI 现场发现流程。**流程注册即文件**:`_meta/<id>-skill.md`
  带 id/title/summary/triggers frontmatter 即被 CLI 自动发现,新增流程零接线
  (audit.py 跳过 _meta/**,流程 frontmatter 不入库文档体检)。
- **薄壳收敛**:删除 .claude/.cursor 下 agent-docs-governance、agent-docs-intake 四个
  分流程壳,各客户端只装一个 `agent-docs-cli` 壳;constitution §7、README、install-prompt
  (改为 CLI 壳安装指令)、两个流程文件头部同步改写。
- **method 三原则入宪法 §1**(用户拍板,源自其对抠图/拆帧方法论的通用化指示):
  ①疆域不地图(只圈边界判据,手法只作可选提示;正确性建立在结构上——对抗验证环+
  agent 智能循环,不建立在按部就班);②正交可复用(一篇 method 一个正交能力,不与宿主
  任务绑死);③组合不强耦合(高级 method=引用组合下层,强耦合不收,先解耦再收)。
  已接线:intake 校验闸门第 2 条、governance 管线 B 蒸馏改稿判据。
- **下轮治理 run 增补事项**:按 method 三原则重审存量 method 卡——重点
  asset-pipeline/methods/character-animation-production.md(应重构为"组合层",把
  循环对抗验收的抠图、对抗验收的拆帧等拆成正交 method);其余 methods 同查。

## 2026-07-11 治理元方法入宪(用户拍板,非治理 run)

- 宪法 §0 增补**治理体系的元方法**:用结构性的 agent 方法治理项目方法——正确性建立在
  结构上(盲重建/对抗验证/最小审批面/机械门禁),不建立在把事情拆到步骤上;库与全部
  治理流程只提供元方法(疆域/判据/结构保证),具体手法至多"可选提示","怎么做"由执行
  agent 现场智能补齐;治理流程自身的写作与重审同受此约束。
- 接线:governance-skill 总原则首条。与 §1 method 三原则构成同一思想的两层:
  三原则管项目方法怎么收,元方法条款管治理体系自己怎么长。

- 2026-07-11 CLI 增补 install 子命令(用户指示):一键安装/修复客户端薄壳,幂等,自动清理
  旧分流程壳;薄壳内容以 cli.py 内模板为唯一生成源(手写壳已核验与模板逐字一致);
  install-prompt 改为一条命令;宪法 §7 记录"CLI 无状态不开 server"取向。

- 2026-07-11 安装口径修正(用户指示):安装动作 = 用户对任何 agent 贴一句话
  ("读 agent_docs/_meta/install-prompt.md 并严格照做…"),agent 按自身客户端机制自适配
  (已知客户端跑 cli.py install;其它 --dir 或 --print 取壳内容适配;无机制则不装)。
  cli.py install 增 --print;install-prompt 改回"贴给 agent 的原文"形态,一句话置顶。

- 2026-07-11 intake:收2/改1/降0/拒0 —— 收「对抗验收抠图法」(adversarial-matting)、
  「对抗验收拆帧法」(adversarial-frame-decomposition)两张正交原语 method 卡
  (asset-pipeline/methods/,严守 method 三原则:疆域不地图、技法只进向下指针);
  改 character-animation-production 向下指针指向该两原语并注明其为"组合层"。
  **注**:此为 07-11 治理 log 所记"下轮治理 run 把循环对抗验收的抠图/拆帧拆成正交 method"
  待办的**加法部分**(补齐缺失的两原语);组合卡的骨架级重构(把内联判读外迁、改阶段/分工)
  属审批级 + 治理 run,本次**未做**,仍留待下轮。素材来源:cld 重扣 12 角色实操(tmp/cld_reprocess_20260710)。

## 2026-07-11 发现面接线(用户拍板两项,解冻既有决策)

- **路由层(批准,全客户端)**:每会话自动载入的指令文件加「开工闸门块」(带
  `agent-docs-gate:begin/end` 标记,由 cli.py install 幂等维护;新增 --print-gate 供其它
  客户端自适配)。已接:CLAUDE.md §A、AGENTS.md;宪法 §6 边界更新——对这两个文件
  **只允许写标记块**,其余内容仍冻结,全面路由器化另须审批。
- **强制层(批准,非阻断,Claude Code 先行)**:翻案首轮"triggers 只查询不接 hook"拍板。
  新增 `_meta/hooks/paths_reminder.py` + .claude/settings.json PostToolUse hook
  (Edit|Write|NotebookEdit):编辑命中 paths-triggers 登记路径 → 经 additionalContext
  注入必读卡提醒,每会话每文件一次,异常静默零退出绝不阻断。已实测:命中/去重/库外/
  坏输入四况 + 哨兵证明 hook 真实触发。其它客户端待其有等价机制再接。
- 发现面现状(四层):路由(指令文件闸门)→ 强制(hook 提醒)→ 流程(六 skill 挂卡+CLI 壳)
  → 治理(last_used 新鲜度/inbox 流量作健康度信号)。

- 2026-07-11 主动发现能力 CLI 化(用户指示):`cli.py install` 现在一键装全三层——薄壳、
  闸门块(CLAUDE.md/AGENTS.md)、强制层 hook(.claude/settings.json,幂等只增不改、坏 JSON
  不碰只警告);hook 脚本 paths_reminder.py 改为客户端无关双模式(Claude Code stdin JSON /
  通用 argv 纯文本 `<file> [sid]`),其它客户端经 `install --print-hook` 取接法自适配;
  install-prompt 同步为"三样东西,层层降级"。实测:双模式命中/未命中、已接检测、全新接线、
  二次幂等、坏 JSON 保护全过。

- 2026-07-13 intake:改2/降1/拒0 —— ENTITY_REF_PARAMS(参数含实体/场景/出生点引用的 action 的条件性第五登记点,parity 测试拦漏)并入 action-registration-quadruple 与 l2-action-primitive-registration 两卡,add-game-action skill 同步对齐;「实体重构引擎」整卡候选降级 inbox 待治理 run(2026-07-13-entity-refactor-engine.md)。
- 2026-07-13 intake:收1/改1/拒0 —— 落地 content/mechanisms/entity-refactor-engine.md(实体迁移/改名/删除走重构引擎;triggers.paths 挂 public/assets/scenes/** 使内容任务可发现引擎),production-mode SKILL 加指针;treated 同名 inbox 记录更新为"仅剩触发面复核"。

## 2026-07-13 治理 run(周期性深度对账,用户不在场)

- **定界**:偏差积压域(runtime 4 条/editor-tools 2 条/content 2 条)+ 07-13 两次 intake 复核;
  管线 A 按四片派盲重建(实体重构引擎/命令通道与无头驱动/叙事存档迁移与信号目录/编辑器
  sidecar 持久化),只读代码禁读库,图谱逐条对账。asset-pipeline / meta 域本轮未做盲重建。
- **对账结论**:entity-refactor-engine 卡全部属实(触发面 scenes/** 复核=维持,该路径本就命中
  6 张内容卡且系用户点名挂上);ENTITY_REF_PARAMS 第五登记点两卡属实,唯一漂移=
  "自定义分支 action 靠自觉登记"实为 `test_custom_branch_actions_pinned` 机械钉单,已修正两卡。
- **自动落地**(9 处):runtime-command-channel 补隐藏 pane 轮询节流×服务端 TTL30s 剪枝、
  快照单槽 last-writer-wins 两坑(+600ms/50条/TTL 数值);headless-visual-verification 补
  "读 src 炸页(git show HEAD 替代)""narrativeWarp 必配 mode=dev + canRemoteEnterState 只放
  entry/exit(拒时仅 recentIssues 无红条)""页内驱动工具箱(800ms 自动泵/瞬移/chooseOption 直调等)";
  save-restore-contracts 补叙事图 migrations 契约(先重映射再校验/warn 不静默/编辑器自动登记/
  无 GUI 盲区/场景无此机制);debug-ui-persistence 由"唯一=vite 中间件"扩为同一原则两种传输
  (+QWebChannel bridge slot,localStorage 仅种子/降级);**新卡** editor-tools/mechanisms/
  emitted-signal-catalog(信号实发四源口径,含 07-13 修复的叙事图 action 树漏扫、meta.emits
  压警告坑、flow 广播条件叶子消费的已知告警噪声);narrative-signal-spine 加口径指针;
  action-registration-quadruple / l2-action-primitive-registration parity 措辞修正。
- **inbox 蒸馏**:8 条中 6 条蒸馏完删除(emitted-signals / entity-refactor-engine / headless-driving /
  narrative-save-migrations / narrative-editor-prefs-bridge / runtime-command-hidden-pane;
  其中 2 条 frontmatter 不合法的 warn 随删清零);2 条升审批级保留并注记(beishi 决策冲突、
  editor-tools norm 红线措辞)。headless 记录中的"听书全拍跑通"里程碑属工作产物,不入库。
- **待批清单(本轮零决策,全部留给用户)**:①(审批面④)beishi-mundane-eerie-redesign 决策卡
  "工头顺序派两尸"与 07-12 重排后数据冲突(已核实),拟新增取代性决策卡+旧卡加部分取代指针;
  ②(审批面①)editor-tools norms 红线「绕过统一保存出口」拟补 sidecar 直写限定句(代码现实
  已核实,norms 未动);③(审批面②,07-11 遗留)character-animation-production 重构为组合层的
  骨架级改稿;④(遗留)CLAUDE.md 全面路由器化仍未批,维持只写闸门块。
- **下轮建议**:①asset-pipeline / meta 域盲重建仍欠;②.ink 全面废弃(2026-06-30 拍板)补正式
  decision 卡(证据在 dialogue-graph-editor 卡,新增 decision 卡不在自动落地清单故未做);
  ③编辑器侧小卡候选(光环境曲线画布/archive 键序/立绘选择器/parallax Web 编辑器)仍挂;
  ④若批准待批②,同步把 sidecar 通道清单落 editor-tools 侧机制卡。

## 2026-07-13 治理 run 追记(用户批准两项审批级事项,当日落地)

- **审批面④(已批)**:新增 content/decisions/2026-07-12-beishi-first-job-yizhuang-reorchestration.md
  (第一单=自由空挡→找活→义庄门口拦活→自己找尸→背回;工头改派后续淹尸单;旧编排入被否清单);
  旧卡 beishi-mundane-eerie-redesign 顶部加"部分被取代"互链指针,其余内容仍有效。
- **审批面①(已批)**:editor-tools/norms.md 红线「绕过统一保存出口自行写盘」按拟定措辞补
  sidecar 限定语(仅动这一条,其余未碰)。
- inbox 两条待批记录(2026-07-12-beishi-lingong-yizhuang-intake、
  2026-07-13-editor-sidecar-vs-unified-save-exit)蒸馏收编后删除,inbox 清零。
- 本轮待批清单余项:③character-animation-production 组合层骨架重构、④CLAUDE.md 路由器化,仍待批。
