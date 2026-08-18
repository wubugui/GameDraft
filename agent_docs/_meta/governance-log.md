# 治理日志

> 作用只有三个:**①防止把已拍板的事重新翻出来问人**;②记录每轮动了什么;③挂未清的账。
> 治理 run / intake 开工前必读 §1 §3。
>
> 2026-08-05 起改为台账体(原 187 行逐轮流水叙事已压缩;过程叙事无判据价值,
> 决策与待办一条未删。历史全文见 git)。§1 §3 滚动维护,§2 每轮追加一行。

## §1 常驻决策台账(已拍板,勿再问)

| 日期 | 决策 | 备注 |
|---|---|---|
| 07-11 | 库址 = 仓库根 `agent_docs/` | |
| 07-11 | **记忆升格政策**:agent 私有记忆里项目契约类内容升格入库、记忆留指针;个人偏好留记忆 | |
| 07-11 | **method 三原则入宪**(疆域不地图 / 正交可复用 / 组合不强耦合) | 宪法 §1 |
| 07-11 | **治理元方法入宪**:正确性建立在结构(盲重建/对抗验证/最小审批面/机械门禁),不建立在拆步骤;库与治理流程只提供元方法 | 宪法 §0 |
| 07-11 | **治理面 CLI 化**:流程注册即文件(`_meta/<id>-skill.md`),各客户端只装一个 `agent-docs-cli` 薄壳,壳与 CLI 均不复制正文 | 宪法 §7 |
| 07-11 | 安装口径 = 用户贴 `install-prompt.md` 给任意 agent,agent 按自身客户端机制自适配 | `cli.py install` 幂等 |
| 07-11 | **intake 与治理同级**:日常单件收编走 intake,成批走治理 run;intake 不动 `last_governed` | |
| 07-11 | 五域 norms 定稿(runtime 由 `docs/运行时开发规范.md` v2 迁入) | |
| 07-11 | **选择器裁定**:只有很短的枚举才允许下拉,其余(大候选集/引用/视觉资产)一律弹窗选择器 | 取代规划期"缩略图网格"红线 |
| 07-11 | **发现面接线**:①路由层=指令文件里带标记的开工闸门块(批准);②强制层=PostToolUse hook 注入必读卡提醒(批准,非阻断)——翻案首轮"triggers 只查询不接 hook" | |
| 07-12 | 背尸第一单改义庄编排,取代"工头顺序派两尸" | |
| 07-13 | editor-tools norms 红线「绕过统一保存出口」补 sidecar 限定语 | |
| 07-14 | **libtv 生成底色铁律**:禁止让模型直接生成透明底,必须纯色实底(灰底优先),透明交本地抠图管线 | |
| 07-15 | **scenario 一等公民退役**(代码 stage-2 未删,卡保持 active 带注记) | |
| 07-15 | editor-tools norms 四硬规则:强化不变量8(镜像语义级 parity)、新增9(fail-safe 不 fail-open)、过程义务3(护栏从最外层用户入口进)、4(rename/delete 三问) | |
| 07-16 | **原始素材归档**:定稿源按「一角色一文件夹」归 `tmp/原始素材/<中文角色名>/`,须与上线动画同步 | 08-05 修订见下 |
| 07-16 | **任何具事件关联的叙事必须走状态机脊椎**(纯孤立 flavor 才可孤立对话);`narrative-flow-authoring` 内化为进策划模式即载入 | |
| 07-21 | 二维场景辐射度还原与发光增益管线定稿(纯 agent / 纯亮度 / 纯模型直出 / 屏幕空间传光均否) | |
| 08-05 | **本轮解冻的四类审批,见 §2 08-05 行** | |

**长期冻结项**:`CLAUDE.md` 全面路由器化——08-05 前一直未批;本轮处置见 §2。

## §2 历轮(一行一轮)

- **07-11 骨架** — 宪法/schema/audit/inbox/日志建立。
- **07-11 首轮建库** — 蒸馏建库五域 84 篇(5 norms + 46 mech + 4 method + 11 recipe + 18 decision);记忆 38 条改指针 + 15 条部分升格;6 个 skill 挂卡引用化。
- **07-13 治理 run** — 四片盲重建(实体重构/命令通道/叙事存档/编辑器 sidecar);9 处自动落地;inbox 8→0(2 条升审批);新卡 emitted-signal-catalog。
- **07-15 治理 run** — inbox 12 条全清;新卡 json-lang-schema-tooling、dvc-oss-restore recipe、scenario 退役 decision;文档 89→92;管线 A 未跑。
- **08-05 治理 run(全盘收敛)** — 用户点名"去旁枝末节、只留抽象主干,精简但不能缺少"。
  六域并行裁剪 + inbox 60 条一次清空(84KB→0),补 7 张零覆盖新卡;三路对抗核查抓回 12 条误删
  (含主脑自己删的 3 条),全部补回。**总信息量 436KB→347KB(-21%),CLAUDE.md 11.7KB→3.8KB(-67%)**。
  详见下节。

## §2.1 本轮(2026-08-05)明细

**范围**:五域全库写作高度裁剪 + 管线 B 全量蒸馏。**管线 A 盲重建仍未跑**(欠五轮),
理由:60 条 inbox 本身是过去三周的代码锚定新鲜证据,已覆盖盲重建大半产出面。

**本轮解冻的审批面**(用户当轮授权"该做什么做什么,不要拿选择题回来",故未逐条上会,全部落地):

| 类别 | 处置 | 依据 |
|---|---|---|
| ① 不变量 | **不加** singleShot context / 条件叶唤醒源两条 norms 条款——已有机械护栏或已在卡内,再抄一份即双源 | 精简优先 |
| ① 不变量 | **加** editor-tools 过程义务「重块默认折叠**且懒建**」——原判"已在门配方"被核查证伪,且它护的是往返保真 | 核查推翻主脑裁定 |
| ① 不变量 | **加** runtime 不变量 11/12(分层解耦、数据驱动)——从 CLAUDE.md §1 迁入,给它们一个库内的家 | 去双源 |
| ② 骨架 | narrative-flow-authoring 八节**不强收进**六栏(多出两节是判据不是阶段) | 收了不减信息 |
| ③ 废弃 | 零篇整篇废弃;跨卡去重抽查后**不做并卡**(现存重复都是"坑卡持根因+消费卡一行指针"的正确形态) | |
| ④ 冲突 | 两张 decision 卡就地取代:UI 观感(80→38 行)、HDR 管线(07-23 重做,原四重裁决降入被否) | 见下 |
| ④ 冲突 | 规矩状态载体**维持 FlagStore**——记录称制作人口头否决,但代码里 `NarrativeOwnerType` 无 `rule`;库不得领先实现立法 | 转 §3 待办 |

**宪法改动**:decision 的过期方式由「永不修改,只被新决策取代」改为
**「就地取代,旧决定降入被否列表,一主题一卡」**——原规则每翻一次案多一张卡,是膨胀源;
防翻案要的是被否路线可见,不是卡片数量。

**库外**(破例,原「CLAUDE.md 路由器化未批准」由用户当轮指令解冻):
`CLAUDE.md` 收成路由器,§1/§2/§3 正文并入各域 norms,只留分类闸门 + 入口 + 每域一行
"最贵的一脚"。前置条件是先给两处无家条款安家(架构铁律→runtime 不变量 11/12;
选择器对照表本就在 editor-tools-iteration skill 里,CLAUDE.md 那份是**第三**份拷贝)。
顺带修掉两处**过期错表**:重建区八项(实为四项)、条件叶子 6 类(实为 8 类)。
闸门标记块原样保留,`cli.py install` 复检通过。

**对抗核查(三路,拿治理前快照逐篇 diff)**:抓回 12 条真误删并全部补回。其中主脑自己删的 3 条
(HDR 还原式 `100×EOTF×2^EV` 的绝对尺度、UI 素材再生成入口、"禁 AI 生成"只管可行走场景背景
这一适用域限定)。另查出一条快照里就存在、本轮未抓到的错:UI 卡仍写"底部渐变 scrim",
而制作人 08-05 已废除任何满屏压暗并定了"标题压左上/菜单左下竖排/全部左对齐",已改正。

**条件叶子数三次数出三个数**(卡上 6 / 域 agent 7 / 核查员实测 8:多 `narrativeCount` 与
`posture`)——正是"列举型以代码为准"的活标本,现库内不再写任何数字。

## §3 悬挂待办(滚动)

1. **管线 A 盲重建**:asset-pipeline / meta 域自建库起从未跑过(欠四轮)。
2. `.ink` 全面废弃(06-30 拍板)缺正式 decision 卡(证据在 dialogue-graph-editor 卡内)。
3. scenario stage-2 代码删除落地时:条件叶 6→4 属审批面①,须同步 content norms 与 CLAUDE.md §2。
4. 编辑器侧小卡候选:光环境曲线画布坑 / archive 编辑器键序 / 立绘编辑器选择器细节 / parallax Web 编辑器。
5. `docs/editor-authoring-surface.md` 重建区八项清单与库内已收缩版本漂移(`docs/` 非本库疆域,需人工同步)。
6. `.claude/skills/` 对 `.cursor/skills/` 的镜像手工维护、已漂(15 → 只镜像 9);`cli.py` 不管 symlink。
7. `.cursor/skills/restart-gamedraft` 引用 Windows `.cmd` 已失效(skill 疆域,非本库)。
8. **规矩状态载体**:制作人 2026-07-26 当面否决 FlagStore(`rule_<id>_acquired` /
   `rule_<id>_<层>_done`),定为「一条规矩 = 一张叙事图,世界侧读 narrative 叶子」;
   但代码未动——`NarrativeOwnerType`(`src/core/NarrativeStateManager.ts`)至今无 `rule`。
   定稿见 `artifact/Design/核心玩法-象理术-方案-2026-07-26.md` §9。
   **实现落地后**再改 content/norms 口径并考虑立「规矩即叙事图」机制卡;
   在那之前库维持 FlagStore 口径,勿让库领先实现立法。
9. `sceneExposureEV` 至今无人消费(只在默认参数表与 REBUILD_KEYS):补实现还是从决策中撤除,
   要人拍板;不定则每轮通读都会重新发现一次。
10. `test_single_shot_context_parity` 只静态扫三个硬编码目录,`tools/parallax_editor`、
    `tools/narrative_editor`、`tools/video_to_atlas` 在覆盖面外(后者现存两处 2 参 singleShot)。
11. `scripts/generate_demo_audio.py` 的 `BASE_DIR` 指向不存在的 `public/assets/audio/`,
    实际音频资产在 `public/resources/runtime/audio/`(一次性工具 bug,非契约;
    修 BASE_DIR 或改参数化输出目录)。

## §4 intake 收编史(一行一次)

- 07-11 收2/改1 —— 对抗验收抠图法、对抗验收拆帧法两张正交原语 method;character-animation-production 改挂向下指针。
- 07-13 改2/降1 —— ENTITY_REF_PARAMS 第五登记点并入两卡;实体重构引擎整卡降级 inbox。
- 07-13 收1/改1 —— content/mechanisms/entity-refactor-engine 落地;production-mode SKILL 加指针。
- 07-14 改1 —— libtv-image-generation 补生成底色铁律。
- 07-16 改1×3 —— asset-pipeline norms 不变量⑥ 归档规矩(两次订正至中文角色名);cutscene-step-semantics 补 Esc 整段跳过。
- 07-16 收1/改2 —— content/methods/narrative-flow-authoring 落地并绑进策划模式载入面。
- 07-21 收1 —— runtime 决策「二维场景辐射度还原与发光增益管线定稿」。
- 08-17 收1/改4 —— meta/mechanisms/atomic-write-windows 落地(Windows 原子写不原子,全仓 18 处就位点收敛到 tools/atomic_io);ui-component-layer 补「面板内键位撞全局快捷键静默失效」坑;save-all-dirty-buckets 与 anim-preview-tool 各挂向下指针;libtv-image-generation 死锚点(tmp/ 下已删脚本)换成仓内稳定路径。
- 08-18 intake:收1/改2 —— editor-tools/mechanisms/scene-view-filter-axes 落地(画布三条视图轴分两层,后置显隐轴必须合一判定,否则互相冲掉);day-night-npc-schedule 补「代码不许出现时段 id 字面量」硬契约与 2026-08-18「整条街一个人都没有」事故复盘;dialogue-voice-channel 的 verified_by 去掉 schema 不支持的 `::类名` 后缀(存量 error,挡收编门)。
