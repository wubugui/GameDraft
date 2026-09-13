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
- 09-12 intake:收1/改3/降3 —— 场景风 + 纸钱薄片 + 背景草木摆动落地(跑马梁示例)。收:runtime/mechanisms/scene-wind(风是空气速度场、一份参数一个钟、粒子/摆动两路增益、近地对数廓线、阵风顺流推进、透视场景真实位移×脚点透视系数、摆动图全时段共用主背景且只写进已有载荷目录、sway.* 登记为可选载荷件、薄片受光 program 只配条带网格)。改:vfx-system(薄片 / 场景风 / area 铺撒指针节)、vfx-workbench(薄片模块与工作台看不全的三处)、scene-lighting(同目录可选件 sway.*)。降 3 条 inbox:跑马梁受光粒子整体偏暗、「时段变体整体没有载荷」应逐场景看、联动改 lit 不重建渲染视图。
- 09-12 intake(第二轮):改3 —— 制作人否掉草木摆动 v1(整张原画 UV 扭曲:近处竹子拉丝、树干与石头跟着扭),换 v2 离线拆层。改:runtime/mechanisms/scene-wind(静态底板只补轮廓内一条带 + 逐株植被网格;树整株绕根刚转、灌丛/竹丛/草根部钉住弯、叶片颤动只在叶像素;石头在分割时从植被扣掉、在底板上永不动;位移软封顶 0.8×补带宽,要更大摆幅是加宽补带不是加增益;摆幅透视改按视深查表——透视轴轴外会把远山查成近处系数;CPU 预算:只铺有像素的格子 + 阵风和角拆分,2.2→0.14 ms/帧;取证读数换成 v2 的)。scene-lighting / vfx-system 的 sway 指针改成新文件名。
- 09-12 intake(第三轮):收1 —— 手持光源(火把)落地:挂件预设自带灯与效果 + 离散状态机 + 跟随灯那一层。收:runtime/mechanisms/held-prop-lights(绝不写作者数据、配 follow 的原件必须跳过、解不出来就不发光不回落 pos、闪烁是一个信号 L(t) 同驱灯强度与发射率、闪烁推送必须限速否则每帧重烘整张光照缓存、死区基准只在真推出去后更新、渐灭到"没有灯"要留上一盏的形状、切状态软停卸下硬停、手持物只入档玩法事实、跨 await 拍世代号;已知坑六条与实测标定全部来自 09-12 无头真机验证)。未改任何既有卡(新机制,无同主题篇);别的会话在同一工作树并行改动,本轮只动新增这一篇。
- 09-12 intake(第三轮):改1 —— 制作人要"能手动设置不扭曲的 mask"(跑马梁近处那丛竹子按场弯曲看着怪异)。改:runtime/mechanisms/scene-wind(新增作者手动锁定出口 sway_lock.png:烘焙的输入、白 = 永不动、当石头处理所以底板那块原样保留、--lock-ids 按实例 id 并进掩码、id 每次重烘会变、不进发行包;已知坑里补竹竿不被认成木质的后果;取证补页内区域像素差的读数)。
- 09-12 intake(第四轮):改1 —— 制作人要"草木增益上限调大,走样我自己控制"。改:runtime/mechanisms/scene-wind(位移封顶从固定 0.8×margin 改成随 gain.sway 按倍数放开、上限 4×,增益 1 仍是压在补带里的安全档;补风力响应实测表:风速 ×2 以后草木饱和而纸钱不饱和、草木增益在越界档线性给量、远山因先撞最大弯角所以层次保得住)。
- 09-12 intake(第五轮):改1 —— 制作人打回"物体对风的响应不真实"。草木从准静态(按当前风速直接摆到位)换成受迫二阶振子(风只给目标角度,每株 / 每顶点自己解),惯性、过冲、余振、与阵风共振都从解算里出来;积分抽成纯函数 stepSwayOscillator 并补 5 条单测(过冲 / 余振周期 / 阻尼单调 / 子步无关 / 长时不发散)。纸钱改成按网格双线性取当前帧真实位移(不再另算一份公式)。改:runtime/mechanisms/scene-wind(新增硬契约「草木有惯性」+ 跑马梁阶跃实测读数 + 纸钱取位移的口径)。每帧 CPU 0.138 → 0.24 ms。
- 09-12 intake(第六轮):改1 —— 制作人打回"风很单一,吹粒子感觉很死,就一个方向"。湍流从"两个数字 + 消费方各自加噪声"换成场内唯一的一片**无散度涡场**(随机波叠加,振幅 ⟂ 波矢,随平均风推进、按翻转率衰变),sampleSceneWind 直接返回平均 + 阵风 + 涡。同时修两处真 bug:纸钱把噪声时间轴按粒子种子错开(每粒一套私有乱流,永远不会一起绕一个涡转)、通用粒子的 drag 路径丢掉了风的竖直分量。F2 加「湍流强度」滑条。补 7 条单测(无散度、三向脉动、rms、空间相干、可复现、sampleSceneWind 带涡、强度 0 不变)。改:runtime/mechanisms/scene-wind(新增硬契约「湍流是一片共享的涡」+ 跑马梁逆风 / 侧风 / 竖直速度实测读数)。
- 09-12 intake(第七轮):改1 —— 制作人定预算"整套风结算 ≤ 2 ms/帧"。落地:热路径正弦换查表(fastCos/fastSin)、VfxRenderer 加视口剔除(新增 getScreen 依赖)、纸钱 plate.segments 4→2(屏上才 10–30 px)、SwayBackground 自测每帧耗时并在 F2 显示(草木 x.xx ms / n 株 / m 顶点)。跑马梁 520 张纸实测从 ≈1.6 ms 降到 ≈0.9 ms。改:runtime/mechanisms/scene-wind(新增预算一节:三条口子按性价比排、量的时候先看基线除掉机器负载、睡着的片因为要颤所以缓存不掉)。
- 09-12 intake(第八轮):改1 —— 制作人报"风速倍率调很大反而一动不动"。根因:弯角用硬截断 min(θmax,·),画面摆的是「此刻弯角 − 平均弯角」,平均与峰值双双顶到天花板后相减恒为 0(实测灌丛 ×2 死、松树 ×3 死)。换成平滑饱和 θ = θmax·x/(1+x)(小风下等价,强风只衰减不归零),叶片颤动幅度同理。新增导出纯函数 swayBendAngle + 4 条单测(含与硬截断的对照)。改:runtime/mechanisms/scene-wind(新增硬契约「弯角必须平滑饱和」+ 实测对照表)。
- 09-13 intake:收1/改1 —— 制作人要"独立工具专门扣植被 mask:自动打底 + 手修 + 预览,还能手标哪些部分是刚体"。先补运行时能力:逐像素刚体度(位移在整株转与弯曲之间插值,同一株可竿刚叶弯),拆层版本 2→3,新增产物 sway_rigid.png 并登记四处载荷镜像。收:editor-tools/mechanisms/sway-workbench(三通道涂层契约、刚体不许塞 matte 的 alpha(canvas 预乘会清零 RGB、运行时 CPU 副本正是这么取的)、作者涂的刚体不参与整株刚转判定、重烘前必须先落盘、涂在没实例的地方会被丢掉、清单不许逐个开原画、.js 的 MIME 要自己钉死)。改:runtime/mechanisms/scene-wind(拆层产物与作者面指针、逐像素刚体度)。跑马梁端到端实测:涂三根竿 → 刚体顶点两两相关性 1.000、弯曲顶点 0.42。
- 09-13 intake(第二轮):改1 —— 制作人报草木工作台"只能画不能擦"。根因:三个通道挤在一张画布上加色画,橡皮 destination-out 一次擦掉三层、且预乘读回会让通道互相冲淡(实测刚体 20828→20446)。改成三张独立通道画布、存盘时才合成 RGBA;橡皮改成只擦当前层的开关 + 右键拖擦、新增 Ctrl+Z 撤销(逐段矩形补丁、反序回滚)与清空本层。改:editor-tools/mechanisms/sway-workbench(新增「三层各画各的」一节:两条坏法、撤销不许只存第一段也不许整张快照、页面取证读数)。
- 09-13 intake(第三轮):改1 —— 制作人三问:能不能实时推、锁死区域怎么看不到、树的枝干怎么不是刚体。落地:① 刚体**自动打底**(分割出的木质默认刚体,作者涂层在其上加减,新增 A 通道=减刚体);② 装场景时把旧的 sway_lock.png 并进「锁死」层(看得见也改得动);③ 实时推送:新增 dev 槽 /__gamedraft-api/runtime-sway + src/dev/runtimeSwaySync.ts,重烘后游戏**原地重装**拆层(不切场景),URL 带 ?v=rev 绕开按 URL 的纹理缓存、新 root 插回原位置、第一次只记 rev、端口按槽应答实探(别只信 discover_game_url)。改:editor-tools/mechanisms/sway-workbench(新增「实时推送」一节 + 通道表加 A + 三条硬契约)。
- 09-13 intake(第四轮):改1 —— 制作人下"迭代到好用无比、数据安全、运行时无 bug"的目标。落地:① 数据安全三道闸(乐观并发拒盖、大面积删除要点头、每次保存留历史 20 份+页面内恢复面板)+ 本地草稿 8 秒一存;② 回归网:无头桌面壳端到端自检 15 条(橡皮只擦当前层/撤销整笔/清空可撤/不冲淡/导出装回量对得上/装场景不报错且原画真画上)、桌面壳启动门、dev 槽插件 6 条、联动同步 13 条、cacheBust 与 swayInsertIndex 6 条;③ 运行时修泄漏(热重载每推一次漏一套纹理 → AssetManager.dropTexture,实测连推 5 次缓存稳定 19 条 127MB);④ 易用:Alt+点检视、烘焙开线程+进度、快捷键([ ] F B 1~4 E X)、状态徽章、视图复位;⑤ dev 槽插件从 vite.config 抽成 src/dev/runtimeSwayApiPlugin.ts(从配置里测会把整份配置拖进 TS 程序)。顺手修 3 个自己埋的 bug:历史文件名同秒覆盖、bake 状态字段与信封 ok 撞名、openScene 引用已删变量导致整页黑屏。改:editor-tools/mechanisms/sway-workbench(新增「作者面有什么」「数据安全」两节 + 5 条硬契约)。
- 09-13 intake(第五轮):改1 —— 同一目标下的收口轮。① **涂层只剩一个写入者**:`sway_field.seed_lock`(`--lock-ids`)原本另造 `sway_lock.png`,正是把制作人的活读回来的那个"一份内容两个来源";改成写涂层 G 通道 + 走 `layers.keep_history`(`_keep_history` 提成公开),新增纯函数 `freeze_into_paint`(别的三通道一根汗毛不动)与 `SeedLockTests` 4 条(含正则钉死"没有任何 `_atomic_bytes(... LOCK_FILE ...)`")。② **草稿不再卡手**:一层 PNG 编码 ≈45 ms、四层 ≈180 ms,原本每 8 秒不分青红皂白编码四层;改成只编码 `chDirty` 的层(增量语义:恢复时先装盘上的再盖这几层)、笔按下时一律不编码、推迟到 idle 并在真跑前再判一次;`channelDataURL` 改成"白+alpha 画到黑底"的 GPU 合成(与原 JS 循环**逐字节相等**,验过 2048×1152×4 层)。顺手堵掉自己因推迟而引入的坑:排队期间切场景会把 A 的草稿写进 B 的键。③ **弱守卫硬化**:`.dvcignore` 两条规则原本只有 substring 断言(pattern 写错一级照样绿),改用 pathspec 按 DVC 自己的 gitwildmatch 真匹路径,并加反面断言(正经拆层产物一个都不许被排掉);场景页那个按钮原本零覆盖且钩子缺失时静默 return,补 1 条。④ **减刚体层的端到端验证**(此前只有单测):跑马梁 1 号那株自动判出 6200 个刚体像素 → 涂满减刚体 → 重烘 `rigid_coverage` 0.38%→0.0%、运行时刚体顶点 11→0;再从工具历史还原,涂层 sha256 与实验前**逐字节一致**、`sway_rigid.png` 回到 8949 像素、刚体顶点回到 11(对照组)。自检 21→27 条。改:editor-tools/mechanisms/sway-workbench(草稿的增量语义与两条手感要求;硬契约「涂层只许有一个写入者」取代原「旧锁定图要看得见」那条并把后者并入)。
- 09-13 intake(第六轮):改1 —— 制作人报"纸钱往左边飞,树看起来往右边倒"。先查后改:符号核过没反,根因是摆动零点取平均风——阵风三次方包络使风弱于平均的时间占大半,树大半时间摆在逆风侧。新增 `wind.swayRest`(缺省 0.7,`SWAY_REST_DEFAULT` / `swayRestAngle`,整株与逐顶点两条路同改)、F2「原画风力」滑条、Python 校验(越界 error、≈1 warning)。跑马梁逐帧实测松树逆风时间 59%→11%、草 54%→0%。取证教训:面板隐藏时定时器采样被节流,先报出的一张 87% 的表是假的已作废;改用页面内同步逐帧调 update。改:runtime/mechanisms/scene-wind(新增硬契约「摆动零点不许取平均风」+ 实测表 + 取证坑)。
- 09-13 intake(第七轮):改1 —— 制作人打回第六轮的 `swayRest`:"原画没有风!这是你编的!"。确认:"原画画的是平均风下的姿态"是 2026-09-11 第一版为塞进 12 像素补带编出来的,把技术限制伪装成物理假定,09-12 的"风大反而不动"与 09-13 的"树往逆风倒"同源;`swayRest` 是同一个编造换了个数。整个删掉:运行时画真实弯角、不减任何东西(`swayRestAngle` / `SWAY_REST_DEFAULT` / F2「原画风力」/ 校验 / 类型全删);真问题补带宽度:`PLATE_MARGIN` 12→48、`FREEDOM_EXTEND_PX` 48→72(测试钉不等式),重烘跑马梁。实测风往左松树梢平均 −10.5 px、往右 0.3% 时间,风往右镜像,草丛逆风 0%。新增 `backgroundSwayWindDirection.test.ts`(真 `SwayBackground`,Shader/Mesh 空壳,变异验过)。改:runtime/mechanisms/scene-wind(硬契约「原画没有风」取代「摆动零点不许取平均风」+ 补带数字)。
- 09-13 intake(第七轮):改2 —— 制作人要"跑马梁纸钱飞的范围要能控制:主编辑器场景页拉一个粒子区域、边界过渡自然不要硬 mask",中途追加"发射区域和范围区域都要能单独配"。落地:① 运行时 `vfxConfine.ts`(范围多边形烘权重网格,判据取粒子正下方地面点;边带里风按权重衰减 / 躺着的按 1−w 慢慢淡出从发射区域补回 / 出框 0.4 s 淡出 / 出生补回按权重拒绝采样,无推回力无裁剪);数据 `vfx[].area` = 发射区域、`vfx[].confine.{area,feather,ceiling}` = 范围区域(不写 area 用发射区域)。② 真跑踩到两个坑入卡:限定时补回从 140–340 高处放 → 强风里每秒 9.4 张在下风边半空淡出,改按 1 s 落地定高(0.04 张/秒);挑落点失败就回收 → 两块区域擦边重叠时总数漏光,改隐身等补回 + 每子步补回封顶。③ 老画布两种区域图元(不是实体、框内不吃鼠标、只改当前实例、提交排下一拍)+ 面板拉/删/限定/边带/限高 + 去勾收着范围区域;顺手修 vfx 行 dict 经 QVariantMap 被按字母重排键序(作者面文档记过的盲区)。④ F2 粒子页区域统计 + 叠加层(内沿按距离取等值线,权重 0.98 等值线是噪声,当场踩到);工作台预览带上 confine;校验器 confine 形状 / 两块不相交 / 群体不吃 / 锚点在范围外。实测跑马梁(只改内存):框外可见 0.2 张、总数不漏、update 中位 0.4 ms 与不限定相同。改:runtime/mechanisms/vfx-system(新增「粒子区域」节)、editor-tools/mechanisms/vfx-workbench(场景页的粒子区域 + 工作台输入表)、docs/editor-authoring-surface。
- 09-13 intake(第八轮):改1 —— 制作人定"草木走 UV 图:先用屏幕 uv 读扭曲后的 uv,再采样原图的任何信息;露出来的地方颜色能补法线也能补",要跑马梁夜景 + 连通的崖墓入口 / 崖墓前段 / 牛头凼全部接上。运行时:网格改渲进 rgba16f 位移图(RG=源减本×覆盖度、A=覆盖度),不打光由合成面读、打光由 LitBackground 读(植物取主光照缓存的源 uv,露出处取"扣掉植物"那份缓存,两份同脏同算、植物动零光照重算),SceneLightingSystem.attach/detachSway,卸载先解绑;打光场景原先不重设风(粒子吃上一场景的风)一并修。烘焙:plate_plan/fill_plate 抽出,底板按时段各用自己原画补(原先抄白天字节),打光场景另出三张补图并登记四处载荷镜像;重构前后白天产物逐字节相同。数据:装 numba(经用户同意走代理,修好 3 条环境失败);崖墓前段只重烘光照 + 补写 sha;跑马梁 / 崖墓前段 / 崖墓入口 / 牛头凼夜景用白天几何 + 夜景画面 rebake;崖墓入口 / 牛头凼夜景补 9 行对齐白天;牛头凼首次完整 build + 导出深度(新增碰撞,出生点 / NPC 可走、出口可达、79% 可走);三张图加 wind(同跑马梁)。改:runtime/mechanisms/scene-wind。
- 09-13 intake(第九轮):改2 —— 制作人要"大植物整体一起扭、不要被扭成波浪,频率可调""刚体要能自己定锚点,F2 和工作台都要加"。运行时:`wind.waveSize`(缺省 20 wu,按株内相对位置收拢湍流相位**与阵风**——只收湍流不够,测试抓到阵风沿风向扫过一株照样错开)、`instances[].coherent` 整体摆、`instances[].anchors` 逐顶点支点(刚体绕最近锚点转)、叶片细抖大小 / 速度可调,F2 三根滑条。烘焙:`sway_overrides.json`(存位置不存 id)→ `apply_overrides` 按位置落株、24 px 吸附、有锚点重算 reach;never_extract。工作台:锚点 / 整体摆两个工具,随涂层保存、撤销、草稿、留历史。缺省值从 180 改成 20 是因为实测相关长度就是二十来 wu(数字要说真话)。收尾时补:夜景载荷目录缺 skyao_probe / skyvis / gi_hitmap / vol_*(崖墓入口夜里角色会静默偏亮),按几何同构从白天拷,validate-data 回到既有 39 条。改:runtime/mechanisms/scene-wind、editor-tools/mechanisms/sway-workbench。
- 09-13 intake(第十轮):改1 —— 制作人报草木工作台"切了场景没反应,画面都不变"。第一版诊断(画布 / 解码大图只进不出、连切几次图片加载不出来)只在内嵌浏览器面板里复现,桌面壳真窗口里旧写法连切 15 次也不卡,**不是他那边的根因**;画布复用 + 清空照样保留(S10)。真窗口里用下拉框把 36 个场景逐个切一遍才抓到:`dev_room` 没有背景图 → `/api/layers` 500 → 异常没人接、零日志,而 `S.scene` 已经改成 dev_room(再 Ctrl+S 会把旧场景涂层存进它名下)。修:全部读到才换场景、失败退回并写日志、确认取消退回下拉框、清单带 `hasBackground` 并禁选。自检 S11 + pytest 2 条,变异验过。取证教训:内嵌浏览器面板不是制作人的环境,复现要在桌面壳真窗口里、按人的操作路径(下拉框 change)全量扫。改:editor-tools/mechanisms/sway-workbench(两条硬契约)。
