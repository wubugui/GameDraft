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
| 09-03 | **两条候选不变量都不升**(条件求值便捷包装受律8约束 / 「降级必须出声」)——已有卡内条款或机械护栏,再抄一份即双源 | 沿用 08-05 先例 |
| 09-03 | **对话立绘尺寸以代码为准 = 360**;首版 240 降入被否列表 | 三处口径打架,制作人裁定 |
| 09-03 | editor-tools 不变量4 去掉写死的"三处同步"、改为逐处对齐并点明加工台例外;验收门"全量绿"改为平台化判据(靶向绿 + 双树失败集合一致) | 审批面① |
| 09-03 | **宪法 §7 的 CLI 命令改走 `sh scripts/py.sh`**(`python3` 在本机是商店占位程序,静默空转) | 唯一一次改宪法 |

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

- **08-31 定点治理(光影一域)** — 制作人指出库里的光影模型与代码不符,盲重建对账后确认:
  2026-08-30「原画就是最终的光照」已取代统一光影的整体重打光,统一角色路径被
  `Game.UNIFIED_CHAR_PATH_ENABLED = false` 整条关死。新卡 `scene-lighting`;
  重写 `character-lighting`;`2026-07-21-scene-radiance-restoration-pipeline` 就地取代成三代沿革;
  `per-scene-exposure` / `coordinate-spaces` / `entity-lighting` / `lighting-scale-reference` 订正;
  CLAUDE.md 光影段与 §0 路由行改写;两份 artifact 设计文档立"已被取代"横幅;
  `tools/scene_relight/README.md` 订正(离线导出变体图**重新成了正路**);inbox 清 3 条、收窄 1 条。

- **08-31 光照烘焙收束(制作人指令)** — 「整个光照烘焙管线收束到一个统一的工具」。
  `scene_relight/bake.py` + `geometry.py` 的几何部分并入角色照明实验室
  (`scene_fields.py` / `scene_geometry.py`),产物从 `lighting2/<图名>/meta.json` 迁到
  `lighting/<图名>/geometry.json`,与 probe 载荷同住;载荷代次 v2,新增 `depth_sha1`。
  **搬家已验为恒等**:四个二进制产物逐字节相同,meta 只差有意改的 `version`。
  顺带修掉同一形态的四处路径缺陷(见 inbox 的 bake-path-missing-one-level),
  其中打包规则那处意味着 **probe 载荷此前一直没进过发行包**。

- **08-31 光照实验室转本地窗口程序(制作人指令)** — 「禁止双开、关窗即退、不要端口冲突」。
  壳提成共用 `tools/desktop_shell.py`(临时端口 / daemon 服务线程 / QLocalServer 单实例 /
  三层灭缓存),两个工具同用;新增 `tools/child_jobs.py`(Windows Job Object)让烘焙与
  装依赖的**子进程随父进程一起死** —— 那是这个工具独有的残留源,重打光工具没有。
  `scene_fields` 补 `--background` / `bake_scene`:一个场景的**全部时段原画各烘一套**
  (此前只烘得到当前生效那张,夜原画的几何场没有入口)。

- **09-03 全域深度治理(两条管线首次同轮跑满)** — inbox **85 → 0**;文档 117 → 127
  (新卡 9 张、改名 1 张、改写数十处)。**管线 A 六片盲重建首次覆盖全部五域**(欠了四轮的
  asset-pipeline 与 meta 补齐),管线 B 五片并行蒸馏。两路对抗核查抓回 1 条真误删 + 6 条事实错误,
  另有 4 条核查员自己的假阳性被主脑实测驳回。审批四题全部拍板(见 §1)。详见 §2.2。

## §2.2 本轮(2026-09-03)明细

**范围**:五域全覆盖。管线 A 按代码分六片盲重建(叙事存档 / 渲染光影 / 场景实体命令通道 /
编辑器 / 内容 / asset-pipeline+meta),管线 B 按域分五片蒸馏 85 条积压偏差记录。

**新增卡片(9)**:`runtime/mechanisms/{dialogue-owner-origin, system-sfx-event-table,
teardown-ordering, narrative-debugger-bridge}`、`editor-tools/mechanisms/{canvas-gesture-safety,
audio-workbench-config-write}`、`editor-tools/recipes/live-editor-forensics`、
`asset-pipeline/mechanisms/scene-relight-tool`、`meta/mechanisms/project-interpreter-entrypoint`、
`runtime/decisions/2026-08-23-physical-derivation-over-fitting`。
**改名(1)**:`action-registration-quadruple` → `action-registration-registry-surfaces`
——登记面是五处不是四处,且卡名焊死数字本身就是缺陷源(库内引用已全部改掉)。

**管线 A 的主要收获**(库内此前没有或写反的):
- 章节包标记已降级为纯组织标签、不 gate 任何运行时——"看起来像开关、实际不生效"。
- 命令通道对参数零兜底:不夹值会把非数写进世界坐标,整局渲染不出来且不报错、不可逆。
- 输入屏蔽只门控游戏侧查询、不门控订阅分发——两套通道判据不对称(正好解释了 08-17 那条
  "键被吃掉"没查到底的坑)。
- **三处活的"绕过统一写盘出口"违例**,都在现役可达路径上,其中一处与统一保存互删。
- content 域**两套零共享的平行校验实现**(运行时 dev 侧 / headless CLI 侧),只靠人工同步。
- 注释承诺的一个标定一致性校验函数**全库根本不存在**;着色核心头注声称的"四方共用"实测只有两方。
- `tools/lightbake/` 已是空壳(内容 09-01 搬进角色照明实验室)。

**对抗核查(两路)**:
- 真误删 1 条(Qt 静默丢弃类型不认识的值那条错误签名)已补回。
- 事实错误 6 条已订正:延迟阴影实现早已物理删除却仍写"待清理"、原子写卡把要求写成了现状、
  引导脚本自带解释器候选表与"唯一入口"措辞冲突、拆除顺序把"事件总线最后清"说错
  (它后面还有几步,资产释放才是最后)等。
- **驳回核查员 4 条假阳性**:过场动作确是白名单制(它只看到了并存的存档态黑名单)、
  配置装载早已不是白名单拷贝、色板按串开关已入库(它按符号名 grep,而库内按规矩不写符号名)。
- 写作高度核查促成的裁剪:把时效性"待办"从机制卡迁出、norms 里的实现级清单降级为指针、
  去掉三处写死的计数、砍掉可推广的通用工程教条。

**记忆升格**:10 条私有记忆按已批政策处理——8 条内容入库后改留指针,
2 条新升格(活进程取证成配方、导出深度的 git/DVC 成对写进机制卡)。
**1 条实测作废并删除**:关于旧独立 baker 的整条记忆,其描述的工具已空、参数体系全仓零命中。

**顺带修掉的库内缺陷**:索引生成器在 Windows 上把 `INDEX.md` 写成 CRLF(与仓库 LF 契约冲突,
每次重生成都报一次换行归一)。

**两条自打脸,记下来**:①本轮有两篇卡被蒸馏 agent 写成了 CRLF——正是本轮刚写进库的那条坑,
收尾行尾自检才抓到(所以这道自检要一直留着);②有一次判"某某是死码"用的是 grep `new X`,
被**私有构造函数 + 静态工厂**骗过,险些把一条活路径写成死码入库。
**判死码要连工厂函数、静态方法、间接引用一起找过再下结论。**

**并发**:收尾时发现另有会话同期在改库(新填了一条偏差记录、并给打包卡加了一条派生产物条款)。
那条记录经核对已被其自身会话完整落卡,本轮一并销账。**治理 run 不独占仓库,收尾前要重跑体检**。

## §2.1 上一轮(2026-08-05)明细

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

1. ~~**管线 A 盲重建**:asset-pipeline / meta 域从未跑过~~ —— **2026-09-03 六片全域跑满,已销账**。
   下一次深度对账建议不早于一个大迭代之后(盲重建是本流程最贵的一步)。
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

12. **光影的"死料"已有处置口径**(制作人 08-31 拍板:继续烘、运行时不读、不进发行包;运行时装载与打包抽取都已摘掉)。**剩下的是代码本身**:`UnifiedCharacterShader.ts` /
    `UnifiedCharacterLighting.ts` 整份、`GiBouncePass`(仍在脏时算 3840×16 次取样但无人读)、
    `lighting2/skyvis_grid.bin` 与 `gi_hitmap.bin`(仍装载)、`SceneLightingDef` 的
    `radianceScale`/`characterShape`/`giGain`、`lighting.placeholder`(零消费者)、
    以及 F2 里对应的旋钮 —— 全部"接着但没人读"。删还是留(等日夜整条线跑通再决定)要人拍板。
13. **角色不吃雾**:雾目前只在背景那一级,角色侧的雾实现只存在于已停用的统一角色 shader 里。
    开雾场景里角色会"贴"在雾前面。是补进 probe 路径还是接受,要人拍板。
14. **一批说"统一光影/重打光"的代码注释已与实现不符**(`GiBouncePass` 头注释、
    `lightingCore.glsl` 的"四方共用"、`LitBackground` 的"P3 接角色"等)。文档已改,注释未动。
    **09-03 补**:同族还有一条——某个标定一致性校验函数,注释说"见 TS 侧那个函数",
    而它**全库根本不存在**。改这一带代码时别把注释当索引。

### 2026-09-03 新挂(本轮查出;判定不在治理疆域内,或需另立项)

15. **`character-lighting.md` 已 236 行,远超"机制卡限一页"**。建议拆三份:①运行时着色契约
    留原卡;②probe/烘焙参数与阶数选型另立;③"滤镜容器里从屏幕反推世界坐标"那族引擎陷阱
    并进 pixi 卡。本轮只做了裁剪(迁走时效性待办、去重),没做结构拆分。
16. **`last_used` 没有写入者**:它本该由"用了这个 method 的人"更新,实践中无人维护,
    于是机械体检每轮重报同样两条"method 久未使用"。要么定一个写入时机,要么让体检改按别的
    信号判、或去掉该字段。**不定则每轮都会重新发现一次**(与第 9 条同型)。
17. **时段切换竞态(已知未修)**:推进时段后立刻切场景约 1/3 概率把切场景卡死
    (挂起的时段换装与场景装载互等)。本轮从一条被蒸馏的记录里捞回来,值得单独立案修。
18. **`tools/lightvolume_lab` 仍挂在启动器上**(早于 08-30 收束,不被任何现役路径引用),
    与「光照烘焙只有一个工具」的口径不一致——菜单里仍能跑到旧工具。启动器属库外疆域。
19. **假护栏三处**:测试配置里的严格开关写在默认参数里**不生效**;`scripts/` 不在收集范围,
    那里既没有仓库写保护、又有一批恒红用例——裸跑看不见,读起来像全绿。
20. **代码侧欠账(本轮只入卡、未修)**:打包工作台归档处有裸就位调用;某个调试用动作的两个
    引用参数是裸文本框且不在选择器登记表内,打错无人拦;**三处工具绕过统一写盘出口**
    (其中一处会与统一保存互删)。
21. **改名的连带影响(库外)**:`.cursor/` 与 `.claude/` 的 add-game-action skill 仍指向已改名的
    卡与"四件套"措辞。治理只写 `agent_docs/`,需人工或另派 agent 同步。
22. **包体与工具杂项**:修复抽取规则后 dev 目标显著变大(按规则出处是有意的),release 也有增长,
    要有人知道;另有桌面壳显式端口路径的双绑风险、窗口模式启动清 localStorage 顺带灭掉查看器
    折叠状态、开发者控制台起的工具不随它退出(是否该随退是 UX 决策,别顺手改)、
    若干存量 CRLF 载荷(重烘会自愈)。

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
- 09-03 intake:收2/改5/降1 —— 实体轨迹动画(烘焙式)收尾。收:runtime/mechanisms/entity-trajectory(运行时只播 keyframes、烘焙产物恒不写 easing、七通道语义缺省由消费侧填、一实体一驱动的抢占矩阵、镜像在旋转内外层决定叠加旋转符号、道具=无动画包的普通 NPC)与 editor-tools/mechanisms/scene-trajectory-authoring(拉线只在新画布、source 与 keyframes 必须同一条命令、空分段返回的空表不许清盘、首键钳位、sampleHz 上限 240 的由来)。改:parallax-scene-runtime(authority 补共用采样器 + easing 通用条款 + 未收编的第三份缓动副本)、entity-move-facing(存放面差异会改变叠加旋转符号 / 直写 x/y 不触发抢占)、scene-canvas-item-parts-and-z(NPC 精灵素材来源有两条)、scene-canvas-v2-document-view-command(场景级 part 不必是点列、活动态是视图状态)、cutscene-step-semantics(跳过终姿的贡献者以代码为准 + skip 不取消在途 moveEntityTo 的既有缺口)。蒸馏并删除 6 条 09-03 偏差记录;降 1 条新 inbox(add-game-action skill 指向已改名卡的死链,库外不在本轮改动面,与 §3 第 21 条同源)。库外同步:docs/玩法功能需求清单 H5.2 加轨迹动画指令、docs/游戏架构设计文档 §5.11 白名单改指 allowlist JSON + 新增 §5.16 TrajectorySystem、docs/editor-authoring-surface 专用表单加 playTrajectory。
- 09-04 intake:收1/改6/降1 —— 轨迹动画从原型改成可落地形态(制作人定案六条:3D 相对曲线做真相 + 运行时只用 R 投影、碰撞用深度还原的几何、桌面壳网页工作台、旧路径整条删、相机不耦合、画面点选打地面得 3D 控制点)。收:editor-tools/mechanisms/trajectory-workbench(独立桌面应用、唯一写入者、保存=烘一次再写、画面/世界两种空间、地面高度场+深度壳碰撞、{x,z,h} 控制点、投影金标与运行时同数、零浏览器缓存)。改:runtime/mechanisms/entity-trajectory 整篇重写(独立资产、帧相对锚点、target 必填、flipX、世界空间开播只用 depthConfig.M.R、不驱动相机、接地 y 跟落点);cutscene-step-semantics(跳过终姿竞争不再有轨迹);parallax-scene-runtime(Python 烘焙机搬到工作台);scene-canvas-v2-document-view-command(轨迹 part 已迁出画布);runtime-norms 未动。降:editor-tools/mechanisms/scene-trajectory-authoring 标 superseded(画布工具/面板/场景级校验/scoped 宇宙全部删除,仍成立的条款并入新卡)。库外同步:docs/游戏架构设计文档 §5.16、docs/玩法功能需求清单 H5.2 轨迹动画条、docs/editor-authoring-surface 专用表单注。数据迁移:雾津街头.trajectories[coin_drop_demo] → public/assets/data/trajectories/coin_drop_demo.json(帧相对锚点,重烘逐字节一致),过场步补 target。
- 09-04 intake(第二轮):改1 —— 制作人打回轨迹工作台原型的交互层("曲线不能整体变换、选点画线要在画布上定、不能靠手填数字"),前端整层重做:画布优先(无段时点画布即开画)、工具模式(选择/加点/抛体/锚点/平移)、选择集+gizmo(移动/旋转/缩放/镜像,整段/整条,固定轴)、抛体落点/最高点/初速直接拖(本地解析反解,真相仍是服务端积分)、世界空间拾取壳表面+离地高度把手、3D 视图可编辑(射线打高度场/壳)、全覆盖撤销重做、页内对话框、参考层(NPC/障碍/网格)、换场景按锚点相对量换算。数据口径新增两条硬契约:存储点==有效点(写点前 normalize 到 delta=0);世界空间存储 h = 离地高度 + restH。新增 /api/scene_shell 与 node 前端逻辑测试。改:editor-tools/mechanisms/trajectory-workbench(作者面怎么用 + 两条契约 + 验证段)。
- 09-04 intake(第三轮):改1 —— 轨迹工作台交互层审查循环收口(Opus 子代理十轮,第 7/8/10 轮 PASS)。教训:3–6 轮在同一族「在飞的异步响应 vs 本地 doc」上逐症修补、两次自己的修法引入回归,根因是没有端到端手势回归。落地 `--selftest`(无头桌面壳 + ANGLE/SwiftShader-WebGL 起真页面,注入 viewer/tests/selftest.js,61 条断言 ~45 s,pytest 里 test_selftest.py 就是它)。第十轮两条 P2 批量收:起点在地面线之下时地面线/落点把手不钳(与 physicsInfo 同判)、时间键纯点一下不算编辑(不走 ensureManual);顺手:空曲线首键补两端、撤销回到落盘态重新算干净(S.cleanKey)。改:editor-tools/mechanisms/trajectory-workbench(验证段改成 --selftest 门 + 四条契约 + verified_by)。
