# tools/ab_compare —— 两个提交的真游戏 A/B 对照

把两个 git 提交(缺省 A = `origin/master`,B = `HEAD`)各自当成**一局独立的真游戏**跑起来,
从外面用同一串输入、同一套确定性控制驱动两边,逐检查点比截图、状态、报错;
再用 A/A、B/B 重复运行量出「同一份代码自己跟自己比」的噪声底,只报**超出噪声底**的差异。

```sh
# Windows(真 GPU、素材在)
node tools/ab_compare/run.mjs --scenes dev_room,河边
# Linux 容器(无显示、无素材)
xvfb-run -a node tools/ab_compare/run.mjs --browser /opt/pw-browsers/chromium-1194/chrome-linux/chrome --swiftshader --scenes dev_room
```

依赖 `playwright-core`(仓库不装;`PLAYWRIGHT_CORE=<包目录>` 指过去)。全部选项见 `run.mjs` 头注释或 `--help`。
锁文件里的 `resolved` 指向 npmmirror;连不上它的环境(比如云端容器)加 `--npm-registry https://registry.npmjs.org/`
(`npm ci --replace-registry-host=always`,tarball 的 integrity 不变)。
结果在 `.tools/ab_out/latest/`:`report.html`(按分歧排序)、`summary.json`、`img/<场景>/…`(A | B | 差异热图)。
退出码:0 一致;1 有超噪声分歧 / B 新增报错 / 有场景无法对照(A 一轮都没起来)/ 独立性复核不过;2 工具自身失败。
带 `--keep-raw` 跑过之后,可以 `--recompare --out <同一目录>` 只换判定参数(`--margin`、`--ignore-row-shift` …)重出报告,不用重跑游戏。

## 为什么要有它

`tools/render_parity/run.mjs` 是把 master 的 src 放进本分支的对照壳里跑(缺的模块从本分支补),
`game_sweep.mjs` 虽然 checkout 了 master,但 node_modules 链的是本分支那份、而且按真实时间跑(动画噪声)。
两者都是**混源**:比出来的差异说不清是谁的。本工具只做干净的 A/B。

## 方法

1. **两棵独立树**:`git worktree add --detach .tools/ab/<A|B>-<sha10> <sha>`。B 取**提交**——主工作区
   未提交的改动不在 B 里(会大声提示)。并行跑几路对照时每路用自己的 `--trees-dir`(如 `.tools/ab-p1`)、
   自己的 `--port` 段和 `--out`:同一棵树上起两个 vite 会互相判对方的依赖预构建过期。
2. **各自的依赖**:每棵树用**自己的** `package-lock.json` 跑 `npm ci`(锁文件 sha256 记在
   `node_modules/.ab-lock.sha256`,没变就不重装)。绝不与另一棵树或主工作区共用 / 链接 node_modules。
3. **各自的 dev 服**:`node <树>/node_modules/vite/bin/vite.js --strictPort`,cwd = 该树,吃该树自己
   未改动的 `vite.config.ts`;带 `GAMEDRAFT_NO_OPEN=1`、`GAMEDRAFT_SWEEP_ISOLATED=1`(命令队列 / 快照 / 存档
   都不碰人手里那份;隔离存档目录每轮运行前清空)。
4. **唯一共享的是素材数据**:`public/resources/runtime`(DVC,约 5 GB)两边链同一个目录
   (Windows junction / POSIX symlink)。没有素材时大声警告后照跑——那时画面只反映「缺素材」路径。
5. **只从外面驱动**:只调 master 上就有的入口——`window.__game.applyRuntimeCommand(cmd)`(dev 运行时命令词表)
   与 `window.__gameDevAPI`(`isReady` / `stepFixedTicks` / `startMinigame` / `playCutscene` /
   `completeDialogueText` …)。不注入游戏代码、不走 HTTP 命令队列。某一侧缺某入口 → 该步记 `unsupported`,不补丁。
6. **确定性控制(两边完全相同)**
   - 固定视口与 deviceScaleFactor;固定 locale / 时区;`--force-color-profile=srgb`;
   - **同源**:两边页面都开在 `http://127.0.0.1:5173/`(仓库规范的 dev 源,`--origin-port` 可改),各侧浏览器用
     `--host-resolver-rules=MAP 127.0.0.1:5173 127.0.0.1:<本侧 dev 服端口>` 改道(这是两边浏览器参数唯一的不同;
     浏览器不会真去连本机 5173,人手里开着的 dev 服不受影响)。否则报错文案、dev 报错浮层里的 URL 端口两边不同,
     本身就是像素 / 报错差异,入口卫兵还会因「不是规范源」多打一条告警;vite 对 IP 形式的 Host 头一律放行,
     HMR websocket 走同一条改道;
   - `page.clock.install({ time: 固定纪元 })`(导航前);`Math.random` 换成定种子的 mulberry32(init script,
     浏览器环境控制,不是游戏补丁);
   - 冷启动 `/?mode=dev&visualCapture&devScene=<id>`,装载期假时钟随墙钟流动;
   - 就绪(`isReady()`、`currentSceneData.id === 目标`,且切换已收尾——或开场演出(过场 / 图对话)正攥着切换等点击;
     注意 `currentSceneId` 在切换**开始**就变了)的
     **同一个任务里**发 `debugSetFixedTickMode(true)` 冻住逻辑,墙钟沉淀一段只让 I/O 落地,
     再 `clock.pauseAt(纪元 + 固定偏移)`——两边停在同一个绝对时刻、同一个 `performance.now()`;
     随后再冻一次(动画时钟在同一刻归零)并重播种;
   - 之后每推进一帧 = 假时钟前进 `round(k·1000/60)` ms(兑现 setTimeout / rAF 驱动的淡入淡出、过场补间——游戏里
     这类东西不走逻辑 tick,光 stepFixedTicks 会卡住)+ `stepFixedTicks(k, 1000/60)`(逻辑 tick 并显式出一帧);
     有网络活动就等它静下来再走下一步。命令 / API 一律「发出去不等」,兑现与否在后续检查点里记录。
   - 截图 `animations: 'disabled'`(DOM 上的 CSS 动画按 Playwright 的规则收尾 / 取消,两边一样)。
   - `--freeze boot`:游戏一挂出 `window.__game` 就经它自己的 `applyRuntimeCommand` 开固定帧模式(init script 用原生
     setTimeout 轮询),装载期一帧真实时间的逻辑都不跑。缺省的 `ready` 模式下,装载期逻辑按墙钟跑到就绪为止,
     **两边装载快慢不同**(实测 master 的 teahouse 冷启动约 11 s、分支约 6 s)就可能留下不同的状态,且 A/A 量不出来——
     实测叙事跳转「听书」在 `ready` 下 `retry.checkpoint` 一边是 `session_start` 一边是 `null`,换 `boot` 后两边都是 `null`。
     看到「状态分歧」先用 `--freeze boot` 复核。`boot` 的短处:装载本身要逻辑 tick 才走得完的(牛头凼的 onEnter 动作序列、
     叙事跳转 `?narrativeWarp=` 的一长串推进)会永远停在 `switching:true, gameState:ActionSequence`。
   - `--freeze pump`(泵式装载,各种类都能用):逻辑同 `boot` 一挂出 `__game` 就冻,**假时钟也从纪元起就停着**
     (只给上下文记一条 `clock.pauseAt(纪元)`、不 `install`——两条日志之间的墙钟间隔会被页内回放成 ticks,`performance.now()`
     的起点就随机器快慢漂了;这样 `Date.now()` = 纪元、`performance.now()` = 0)。**还要再补一段 init script 当场停钟**:
     Playwright 的 `inject()` 装完假时钟先 `resume()`(随墙钟走),`pauseAt` 日志要等页面第一次碰时钟 API 才回放,回放又不撤
     resume 时排下的墙钟定时器(最长 100 ms)——模块还在网络上、页面前 100 ms 没碰时钟时,`performance.now()` 被推走约 100 ms 才停,
     之后那个定时器还会在墙钟里再跑一次到期定时器。实测整条装载时间线偶发整体晚 100 ms(6 帧)、或两步之间假时刻被推走 3 ms。
     排在时钟脚本之后调一次页内 `controller.pauseAt(纪元)`:立刻回放、`_innerPause` 撤掉那个定时器。泵每次读状态都核对假时钟
     是否停在上一步走到的刻度,动了就记 `clockLeaks` 并大声报。之后由 node 逐帧推:
     `循环 { 等真异步落地 → 同步 evaluate 读状态 → 启动失败 / 就绪(判据同上)就停 → 游戏还没挂出来 / 还没冻住就只等不推 →
     假时钟前进一步 }`。一步 = 走到 min(下一个**非 rAF** 定时器, 本帧末):定时器落在本帧之内就只走到它、不跑逻辑 tick
     (「await setTimeout(0)」这类让一下主线程的写法真机上只花零点几毫秒,整帧量化会放大成整整一帧——实测 master 揭幕闸里
     GlProgramWarmup 逐个交接之间的 `wait(0)` 让茶馆装载比分支多出 1 帧);否则走到帧末(帧末 = round(n·1000/60) ms,
     途中的 rAF 照常触发)+ 有 stepFixedTicks 了就恰好一个逻辑 tick。定时器表只读 Playwright 注入的假时钟内部
     (`__pwClock.controller._timers`),读不到就退回整帧推进。
     页内定时器 / rAF(加载遮罩淡入淡出、揭幕闸的 `setTimeout` 轮询与粒子预热分片、Howler 的 load 事件、luma 管线链接的 4 ms 轮询 …)
     只在「前进一步」里兑现,真异步只在步与步之间落地,于是**装载帧数只取决于游戏装载里等了多少个定时器 / rAF,与机器快慢无关**。
     「等真异步落地」= 网络静下来(vite 模块、动态 import、fetch 都是请求 → quiesce)且下面这些在途计数都为 0
     (同步读现成字段,不调游戏逻辑):渲染器还在 init;AssetManager 各桶在途装载(不含 audio 桶——Howler 的 load 事件走
     `setTimeout(0)`,要等假时钟);Howler 里 `_state === 'loading'` 的声音(XHR + decodeAudioData);master 的 GlProgramWarmup
     后台并行编译中、`COMPLETION_STATUS_KHR` 仍为 false 的程序(只读查询);分支的渲染管线原生校验 pending(luma `linkStatus`)、
     着色器编译信息未回(luma `compilationStatus`)、以及 luma 已链接但 RHI 就绪链(第二次 getCompilationInfo、原生错误作用域出栈)
     还没落定的管线——即 engine2d `pipelinesReady` 等的那些真异步。最后这一类实测要几十到几百毫秒墙钟才回来,静止窗兜不住;
     不单独等它的话,下一帧的 `queue.submit` 顺手把它冲回来,分支的揭幕闸就比 master(GL 同步编译)晚整整一帧
     (牛头凼实测 A 98 帧 / B 99 帧,onEnter 的三把火晚一拍,像素差 0.014%)。`document.fonts` 在装;DOM 里没解码完的 `<img>`。再要求进度指纹(上面各计数、各桶条目 / 统计、管线就绪数、场景 / 切换 / 状态机、事件总线序号、DOM 节点数、画面盒尺寸、
     网络活动序号、报错条数)连续 `--pump-settle`(缺省 40)ms 墙钟不变——兜住没点名的短尾巴(ResizeObserver 回调、第二次
     getCompilationInfo、错误作用域出栈 …)。某项在途超过 `--pump-stall`(缺省 5000)ms 既不落地、指纹也不动 ⇒ 判它其实在等假时钟,
     记一条 stall 照推(该项当时的计数记成底数,之后只挡超出的部分)。
     就绪后**不**墙钟沉淀、**不** `pauseAt` 跳秒(那会一次性触发途中所有定时器);就绪若落在帧内定时器步之后(帧中间),
     先照常泵到下一个整帧边界(带那一帧的逻辑 tick)再同步点(再冻一次 + 重播种)——master 揭幕闸的 `wait(0)` 接力每跳推假时钟 1 ms,
     就地同步两边会差几毫秒,之后按 rAF 16 ms 一拍读 `performance.now()` 的补间(过场淡入淡出、标题)隔一二十帧错一拍、叙事留痕时间戳也不同。
     两边装载帧数相同 ⇔ 同步点的绝对假时刻相同(= 纪元 + 就绪那一帧 + 1 帧)。
     装载之后的锁步推进也照此办理:每一帧推进前后都 `pumpIdle`(等装载桶 / 解码 / 管线 / 字体落地、指纹静止),
     运行中才装的东西(过场插图、切场景的原画、HTMLText 生成)才不会早一帧晚一帧落地——只等网络的话,实测说书过场同侧两局
     同一检查点整幅原画错位(同侧噪声 15%)。代价是每帧多一个静止窗;`--no-pump-run` 关掉(运行期停顿记在 `runPump`)。运行记录 `boot.pump` 里记装载帧数 / 逻辑 tick 数 / 帧内定时器步数 / 首个 tick 的帧号 / stall /
     clockLeaks / 阶段表(帧号 → 场景、切换、状态机、切场遮幕、装载步骤文案、没就绪的管线)/ timerLog(每个帧内定时器步:类型 + 延时 @ 建立时刻)/
     idleLog(每次等待里见过的在途项、新发的请求);`AB_PUMP_TRACE=1` 再记每次等待里指纹哪几段在第几毫秒变了(`boot.pump.trace`)。
     两边对不上时照这些找是哪一段多了帧。每个场景跑完打一行各轮帧数,**不同就大声报**:
     每侧两轮各自一致而 A≠B → 「装载帧数 A≠B」(判失败:两边装载等的定时器 / rAF 个数不同);同一侧两轮就不同 →
     「装载帧数抖动(泵不确定)」(只提示:泵没兜住某个真异步,这个场景的对照不可信)。代价是慢(每帧至少一个静止窗)。
7. **检查点取证**:两张截图——**整页**(画布 + DOM 覆盖层,判定依据)与**画布层**(把不含画布的 DOM 元素临时
   `visibility:hidden` 再截,截完原样还回;不改布局、不触发 ResizeObserver,游戏无感)——分得清差异出在渲染器还是
   DOM(比如 dev 报错浮层);自上个检查点以来的 console error / warning / pageerror /
   失败请求、状态探针(场景、玩家、相机、`getNarrativeDebugSnapshot()` 里两边都有的字段:旗标、任务、叙事、
   UI 状态、HUD / 实体可视状态、对话、过场、小游戏……)。缺素材类报错(404、图 / 音频解码失败)单列,不参与判定。
8. **噪声底**:每个场景按 A1、B1、A2、B2 交错跑,整页与画布层各算一遍。像素 A/B 差取 `min(A1↔B1, A2↔B2)`,噪声取
   `max(A1↔A2, B1↔B2)`,超过 `噪声 × --noise-factor + --margin` 才算分歧;状态路径同理(两轮都差、且
   A/A、B/B 都不抖才算;两边都是墙钟毫秒时间戳、差不到一帧的路径单列「亚帧时间戳差」只提示——装载期 master 的着色器预热 `wait(0)`
   接力让叙事跳转在装载期推的迁移留痕晚 3 ms,同步点之后的时间轴两边严格相同);报错要 B 有而**任何一轮 A 都没有**才算新增
   (只在部分 B 轮出现的记「偶发」,不判失败)。
   超阈值像素里还会数一下能被 **±1 行位移**解释的比例(A 的像素 ≈ B 上 / 下一行同列);≥95% 能解释的标
   「≥95% 可由 ±1 行位移解释」——多半是下面「局限」里的半像素水平边,加 `--ignore-row-shift` 可让它不判失败(照样列出)。
9. **独立性复核**(跑完自动做,写进报告):两棵树 `git status --porcelain` 不许有已跟踪文件改动;
   `node_modules/.vite/deps/_metadata.json` 里每个预构建依赖的来源必须在本树内;页面请求里不许有指向树外的
   `/@fs/` 路径;node_modules 不许是链接。

## 场景表

`scenarios.mjs` 里数据驱动(改节拍改 `TEMPLATES`):scene(进场景 +30 / +180 帧)、npc(每场景前几个有对话图的
NPC:交互 → 补完打字机 → 推进 → 选第 0 项)、minigame(`startMinigame` + 点击 + 拖拽)、cutscene(`playCutscene`,
每 60 帧一个检查点并补完台词 + 点一下)、warp(`?narrativeWarp=`,之后每 60 帧补完打字机并点一下,把最后一跳的开场演出往前推)、resize(改视口再还原)、dpr(DPR=2,去掉
`visualCapture`——它把渲染分辨率钉死在 1)。`--perf` 另跑真实时间的帧耗时与 JS 堆(三轮切场景后 gc 再读)。

**feature**(`features.mjs`):每条冷启动一个合适的场景、触发**一项游戏功能**,触发后立刻与播放过程中按帧打点
(动画类 +10 / +30 / +90 / +240 … 帧)。十个类别,`--features` 按类别名 / 完整 id / 条目名前缀过滤:

| 类别 | 内容 |
|---|---|
| `time` | 每个带 `timeVariants` 的场景 × 每个变体:`advanceTimeTo`(fade)→ 遮幕 / 整场景重载 / 揭幕;开局就在的那段(午)先推到基底时段再推回来 |
| `burn` | 场景里每个可燃实体(热区 / NPC)点燃 → 熄灭 → 复原;可燃挂件挂到手上再点 |
| `strike` | 雷符的 `strikeThreat` 参数(补固定 seed)在三个场景劈;雷符 `use.actions` 整段原样跑 |
| `vfx` | 蝙蝠群起飞 / 惊扰 / 归巢、布置实例播放 / 收、雷符三团临时效果、风场、惊扰场、画布特效、挂件一次性效果 |
| `prop` | 夜里的火把:点着 → 护火键 Q 按住 → 熄灭 → 重燃 → 举着走 → 摘下 |
| `fx` | 阵风、压暗、闪白、震屏、缩放(含 1.37)、淡黑 / 黑场、叠图 / 叠化、呼吸图、文档揭示(叠化 / 模糊图)、说明卡 |
| `ent` | NPC / 热区显隐、表情与气泡(含画外贴边)、阴影绑定、动画、走位 / 跳、热区展示图 |
| `ui` | 背包 / 任务 / 规矩 / 书架 / 地图 / 商店 / 暂停菜单 / 对话记录:开 → 点一下 → 滚轮 → 关 |
| `fg` | 前景层:人摆到树后三处、树前、从树前走到树后、树旁落雷(白天 / 夜) |
| `player` | `playerMoveTo` 走到另一个出生点;蹲 / 凝视 / 踢 / 跳 |

参数一律照抄游戏数据里的真实用法(能从数据现取的现取:时段变体、可燃物、雷符参数、粒子实例、风场 …),
并尽量在数据用它的那个场景里跑。入口只有 master 就有的 `debugExecuteAction`(跑任意 ActionRegistry 动作)、
其它 dev 运行时命令与 `__gameDevAPI`,外加**外部输入**步骤——`{key}` / `{keyDown}` / `{keyUp}` / `{click}` / `{wheel}`
= Playwright 真键盘 / 真鼠标(面板快捷键只能这样按),不注入游戏代码。跑马梁的走位类条目先用 `debugSetNarrativeState`
把 wrapper 置到终态「下梁」,免得人一靠近树就进风口过场。

**mainline**(`mainline.mjs`):按主线顺序把游戏**玩一遍**。`dev_narrative_warps.json` 的每个跳转点一条(`找吃的` 太长拆成
`找吃的` + `找吃的~赌坊` 两条),`?narrativeWarp=` 冷启动后按叙事状态机把这一拍推完,结尾开一圈面板(I / Tab / R / B / M / L / Esc);
另有 `mainline__chain`:从「听书」起同一次启动按序接完全部拍。`--beats <拍,…>` 过滤(拍名、条目名前缀、`chain`)。

- 节拍从数据推:对白图逐节点走(line 的拍数、choice 的 promptLine、runActions 里的过场 / 长按 / 水下小游戏 / 切场 / 说明卡 /
  发物 / 发信号 → 信号落到的状态 onEnter 再演什么),过场按步骤表估帧数与点击数,长按按 fillSeconds 与 interrupt 停点,
  水下小游戏按实例 bounds 算要点的箱子在屏幕上的位置,区按多边形取内点把人放进去(onEnter 照常触发)。
- 推进:每轮 `completeCutsceneText` + `completeDialogueText` + `playerAdvance`(图对话 / 脚本台词)+ `playerTap`(过场台词 /
  点击继续)+ 一个真键:`Digit<n>`(下一组选项要选的那项:DialogueUI / ActionChoiceUI 都认数字直选;预测差一两句也照样选对)
  或 `ShiftLeft`(不选任何项的「任意键」:关说明卡 / 检视框)。选项缺省第 0 项;喊名要喊对的从图里找发 `*_right` 的那项。
  长按全程不松 Space(每轮再发一次 repeat keydown:长按条认、对白不认),interrupt 带出来的台词靠 playerAdvance 推。
- 跳转点做不到的地方(条目 note 里点名):夜巡 / 出南门 / 六图版先重放赌坊对白里的 `advanceTimeTo 夜`;出南门重放打更人给的
  东西 + 0 价洋火、`setActiveIgniter`、纤藤的 use 动作;望山弹的地图节点坐标推不出 → `debugSwitchScene 跑马梁` 代替点地图;
  「义庄镇尸」「终幕」两个跳转点最后一跳自带要点击的演出、在 dev_room 里等 → 就绪永远等不到,改从「招募」冷启动再按原 recipe
  逐跳补(义庄从管事对白 + 进门区正常进)。
- 跳转点在 master 上**不一定落得到 recipe**:dev 模式不吃 `startupFlags`,主图 `flow_xungou_main` 冷启动停在 `state_1`,
  从那里到 `s02_beishi` 起那一串没有迁移,非 scenario 图 `planRemoteAdvance` 又不给一发直达(只报「铺垫未完全到位」照样进场)——
  「梦待死之礼」起每个跳转点的主图都停在 `state_1`,按主图门控的区(河边递纸、码头水边、义庄进门 …)一个都不触发。
  脚本按 master 的口径推演实际落地,落不到的非 scenario 图进场后 `debugSetNarrativeState` 从目标那一串的根逐跳补上
  (`state_2`…`state_9` 不经过:途中会触发赌坊 / 癞子的 reactive 迁移、路遇私铸钱的区,所以按 `state_2 到过` 门控的东西仍与真玩不同,两边一致)。
- 世界模型(排节拍时推演):走位从上一次知道的位置算(出生点 / 摆人点 / 上段终点 / NPC 坐标,×1.15 余量);呼吸图 `fadeOut` + `wait`
  按资产参数算(梦里盖脸纸约 42 s);叙事按脚本置态 + 对白信号 + `state:图:状态` 连锁 + 叙事条件判得出真的 reactive 迁移 + 脚本发的物品推;
  每次把人放进区都拿它核区的条件,判得出不成立 `--list` 报错(zoneGate)。区里摆人避开峰值 ≥ 5 HP/s 的 `healthThreat` 圈
  (跑马梁喊声区顶点平均离路边身影 54 px,近身 1000 HP/s),尽量不贴别的区。
- 长管线:拍间只往前补叙事状态(`debugSetNarrativeState`,按图拓扑判前后,够不着从目标那一串的根逐跳,比如 state_9 → s02_beishi),
  场景能走过去就走热区 / NPC,否则 dev 切;超过 600 帧的过场 Esc 二次确认跳过;只留拍界检查点。
- 已知数据缺陷(不是渲染差异):义庄 `T_出义庄` 点名的出生点 `from_yizhuang` 雾津街头里没有,master 静默退回缺省出生点;`--list` 记告警。
- 中途切场景后插一个 `{inScene}` 标记(driver 不执行),`--list` 的对账据此按新场景核对 NPC / 热区 / 坐标;条目另带 refs
  (过场 / 对白图与节点 / 叙事状态 / 信号 / 区 / 热区点名的出生点 / 长按 / 小游戏 / 物品 / 商店 / 说明卡)逐条对 master;
  另有推演出来的 zoneGate(区的条件在推演状态下不成立 → 错)与 unsafePlacement(区里避不开要命威胁 → 告警)。

`--list` 只打场景表(不建树、不起 dev 服、不开浏览器):A 侧数据读 `.tools/master-ro`、B 侧读当前检出,打完表再拿
master 那棵核对每条引用——场景、运行时命令、`__gameDevAPI`、动作类型与 manifest 必填参数、各类数据 id、动画状态 /
图片路径(有素材目录时)、按键、坐标范围、检查点名唯一(`validate.mjs`),有错退出码 1。改了 `features.mjs` 先跑它。

## 局限

- **不是逐位确定**:装载期是真实时间(异步加载完成的先后、就绪到冻结之间的那一两帧),Web Worker 里的
  `Math.random`、`crypto.getRandomValues`、GPU 驱动的非确定性都不受控;所以才要 A/A 噪声底。噪声底只来自
  两轮,偶发的大抖动可能漏进 / 漏出判定——看报告里的 A/A、B/B 热图。`--freeze pump` 把装载期也拉进假时钟,
  剩下的不确定只有:一帧之内(假时钟逐个触发定时器、之间回到真事件循环)恰好落地的真异步,以及 pumpIdle 没点名、
  又长过静止窗的真异步——两者都会表现为「装载帧数抖动」,不会悄悄混进像素差。
- 装载期 Playwright 假时钟虽是「随墙钟流动」,实测走得比墙钟慢好几倍(页面定时器多时尤甚),所以装载比平常慢;
  只影响装载耗时,不影响之后的确定性。就绪等待的超时因此由 node 侧按墙钟掌握(`--boot-timeout`;pump 下管整个泵式装载)。
- 锁步推进里「假时钟前进」与「逻辑 tick」是先后两段,不是游戏真实运行时的逐帧交错;两边一致,但不等于真机节奏。
- master 的 Pixi 走 WebGL、分支的 engine2d 走 WebGPU:恰好落在半像素上的水平边(1 像素线、面板上下沿)会有
  一行系统性差异(默认帧缓冲光栅化方向相反),属已知项;报告里按「±1 行位移可解释」单独标出。
- dev 报错浮层(「运行时问题 (dev)」)按报错到达的先后排列,而装载期是真实时间,所以缺素材时它在整页图上
  A/A 就会抖(几个百分点);这正是要看画布层数字的原因。浮层只在有报错时出现,有素材时应少得多(未在有素材的机器上实测)。
- 缺素材时(比如云端容器)画面对照只覆盖「无原画、无光照数据」路径,光照 / 原画相关的回归看不到。
- NPC 对话、小游戏、过场的输入是固定脚本(不看状态分支);没走到的分支不在对照范围内。
- 树放在 `.tools/ab/` 下,父目录链上就是主工作区:模块解析若在树内找不到依赖会爬到主工作区的 node_modules。
  `npm ci` 保证声明过的依赖都在树内;未声明的漏网之鱼靠第 9 条复核抓出来(报告「独立性复核」)。
- 性能数字是有头浏览器里 rAF 间隔(受垂直同步上限),只能看量级与 A/B 的相对变化。
- 全量(36 个场景 × 各种类 × 4 轮)要跑很久,日常先用 `--scenes` / `--only` 过滤。
