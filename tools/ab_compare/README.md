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
结果在 `.tools/ab_out/latest/`:`report.html`(按分歧排序)、`summary.json`、`img/<场景>/…`(A | B | 差异热图)。
退出码:0 一致;1 有超噪声分歧 / B 新增报错 / 独立性复核不过;2 工具自身失败。
带 `--keep-raw` 跑过之后,可以 `--recompare --out <同一目录>` 只换判定参数(`--margin`、`--ignore-row-shift` …)重出报告,不用重跑游戏。

## 为什么要有它

`tools/render_parity/run.mjs` 是把 master 的 src 放进本分支的对照壳里跑(缺的模块从本分支补),
`game_sweep.mjs` 虽然 checkout 了 master,但 node_modules 链的是本分支那份、而且按真实时间跑(动画噪声)。
两者都是**混源**:比出来的差异说不清是谁的。本工具只做干净的 A/B。

## 方法

1. **两棵独立树**:`git worktree add --detach .tools/ab/<A|B>-<sha10> <sha>`。B 取**提交**——主工作区
   未提交的改动不在 B 里(会大声提示)。
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
   - **同源**:两边页面都开在 `http://127.0.0.1:5200/`(`--origin-port`),各侧浏览器用
     `--host-resolver-rules=MAP 127.0.0.1:5200 127.0.0.1:<本侧 dev 服端口>` 改道(这是两边浏览器参数唯一的不同)。
     否则报错文案、dev 报错浮层里的 URL 端口两边不同,本身就是像素 / 报错差异;
     vite 对 IP 形式的 Host 头一律放行,HMR websocket 走同一条改道;
   - `page.clock.install({ time: 固定纪元 })`(导航前);`Math.random` 换成定种子的 mulberry32(init script,
     浏览器环境控制,不是游戏补丁);
   - 冷启动 `/?mode=dev&visualCapture&devScene=<id>`,装载期假时钟随墙钟流动;
   - 就绪(`isReady()`、不在切场景、`currentSceneData.id === 目标`;注意 `currentSceneId` 在切换**开始**就变了)的
     **同一个任务里**发 `debugSetFixedTickMode(true)` 冻住逻辑,墙钟沉淀一段只让 I/O 落地,
     再 `clock.pauseAt(纪元 + 固定偏移)`——两边停在同一个绝对时刻、同一个 `performance.now()`;
     随后再冻一次(动画时钟在同一刻归零)并重播种;
   - 之后每推进一帧 = 假时钟前进 `round(k·1000/60)` ms(兑现 setTimeout / rAF 驱动的淡入淡出、过场补间——游戏里
     这类东西不走逻辑 tick,光 stepFixedTicks 会卡住)+ `stepFixedTicks(k, 1000/60)`(逻辑 tick 并显式出一帧);
     有网络活动就等它静下来再走下一步。命令 / API 一律「发出去不等」,兑现与否在后续检查点里记录。
   - 截图 `animations: 'disabled'`(DOM 上的 CSS 动画按 Playwright 的规则收尾 / 取消,两边一样)。
7. **检查点取证**:两张截图——**整页**(画布 + DOM 覆盖层,判定依据)与**画布层**(把不含画布的 DOM 元素临时
   `visibility:hidden` 再截,截完原样还回;不改布局、不触发 ResizeObserver,游戏无感)——分得清差异出在渲染器还是
   DOM(比如 dev 报错浮层);自上个检查点以来的 console error / warning / pageerror /
   失败请求、状态探针(场景、玩家、相机、`getNarrativeDebugSnapshot()` 里两边都有的字段:旗标、任务、叙事、
   UI 状态、HUD / 实体可视状态、对话、过场、小游戏……)。缺素材类报错(404、图 / 音频解码失败)单列,不参与判定。
8. **噪声底**:每个场景按 A1、B1、A2、B2 交错跑,整页与画布层各算一遍。像素 A/B 差取 `min(A1↔B1, A2↔B2)`,噪声取
   `max(A1↔A2, B1↔B2)`,超过 `噪声 × --noise-factor + --margin` 才算分歧;状态路径同理(两轮都差、且
   A/A、B/B 都不抖才算);报错要 B 有而**任何一轮 A 都没有**才算新增(只在部分 B 轮出现的记「偶发」,不判失败)。
   超阈值像素里还会数一下能被 **±1 行位移**解释的比例(A 的像素 ≈ B 上 / 下一行同列);≥95% 能解释的标
   「≥95% 可由 ±1 行位移解释」——多半是下面「局限」里的半像素水平边,加 `--ignore-row-shift` 可让它不判失败(照样列出)。
9. **独立性复核**(跑完自动做,写进报告):两棵树 `git status --porcelain` 不许有已跟踪文件改动;
   `node_modules/.vite/deps/_metadata.json` 里每个预构建依赖的来源必须在本树内;页面请求里不许有指向树外的
   `/@fs/` 路径;node_modules 不许是链接。

## 场景表

`scenarios.mjs` 里数据驱动(改节拍改 `TEMPLATES`):scene(进场景 +30 / +180 帧)、npc(每场景前几个有对话图的
NPC:交互 → 补完打字机 → 推进 → 选第 0 项)、minigame(`startMinigame` + 点击 + 拖拽)、cutscene(`playCutscene`,
每 60 帧一个检查点并补完台词 + 点一下)、warp(`?narrativeWarp=`)、resize(改视口再还原)、dpr(DPR=2,去掉
`visualCapture`——它把渲染分辨率钉死在 1)。`--perf` 另跑真实时间的帧耗时与 JS 堆(三轮切场景后 gc 再读)。

## 局限

- **不是逐位确定**:装载期是真实时间(异步加载完成的先后、就绪到冻结之间的那一两帧),Web Worker 里的
  `Math.random`、`crypto.getRandomValues`、GPU 驱动的非确定性都不受控;所以才要 A/A 噪声底。噪声底只来自
  两轮,偶发的大抖动可能漏进 / 漏出判定——看报告里的 A/A、B/B 热图。
- 锁步推进里「假时钟前进」与「逻辑 tick」是先后两段,不是游戏真实运行时的逐帧交错;两边一致,但不等于真机节奏。
- master 的 Pixi 走 WebGL、分支的 engine2d 走 WebGPU:恰好落在半像素上的水平边(1 像素线、面板上下沿)会有
  一行系统性差异(默认帧缓冲光栅化方向相反),属已知项;报告里按「±1 行位移可解释」单独标出。
- dev 报错浮层(「运行时问题 (dev)」)按报错到达的先后排列,而装载期是真实时间,所以缺素材时它在整页图上
  A/A 就会抖(几个百分点);这正是要看画布层数字的原因。有素材、没报错时浮层不出现。
- 缺素材时(比如云端容器)画面对照只覆盖「无原画、无光照数据」路径,光照 / 原画相关的回归看不到。
- NPC 对话、小游戏、过场的输入是固定脚本(不看状态分支);没走到的分支不在对照范围内。
- 树放在 `.tools/ab/` 下,父目录链上就是主工作区:模块解析若在树内找不到依赖会爬到主工作区的 node_modules。
  `npm ci` 保证声明过的依赖都在树内;未声明的漏网之鱼靠第 9 条复核抓出来(报告「独立性复核」)。
- 性能数字是有头浏览器里 rAF 间隔(受垂直同步上限),只能看量级与 A/B 的相对变化。
- 全量(36 个场景 × 各种类 × 4 轮)要跑很久,日常先用 `--scenes` / `--only` 过滤。
