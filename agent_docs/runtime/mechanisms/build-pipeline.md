---
id: build-pipeline
title: 打包管线(只读抽取 · dev/发行双档 · 产物验收门)
domain: runtime
type: mechanism
summary: 打包只从开发树只读抽取,绝不改动开发数据;裁剪一律写成"不抽取";清单=JSON引用闭包+传递闭包+id约定+显式规则(光照载荷按载荷自己的 shading.mode 展开,文件名表与运行时共用一份);输出目录是每次传的参数、不进配置;静态清单证明不了完备——release.mjs 默认无头真跑每个场景反向核对清单(scene_sweep),verify 再做开发树→产物的光照载荷平价
status: active
authority:
  - scripts/release.mjs
  - tools/build/asset_manifest.py
  - tools/build/manifest_rules.json
  - tools/build/build_config.json
  - scripts/package.mjs
  - scripts/verify_build.mjs
  - scripts/scene_sweep.mjs
  - tools/build/scene_sweep.py
  - src/core/lightingPayloadFiles.ts
triggers:
  paths: ["tools/build/**", "scripts/release.mjs", "scripts/package.mjs", "scripts/verify_build.mjs", "scripts/scene_sweep.mjs", "scripts/lib/**", "src-tauri/**", "vite.config.ts", "src/core/lightingPayloadFiles.ts"]
  topics: [打包, 构建, 发行, build, package, release, 抽取清单, manifest, Tauri, exe, ffmpeg, ogg, 输出目录, 自动化构建, 漏抽, 全场景扫描, sweep, atlas_bin]
  tasks: [出发行版, 改打包, 加素材类别, 接自动化构建, 排查包里失效]
last_governed: 2026-09-06
---

## 是什么(一句话)

把开发树里的东西**抽取**成一个能独立跑的游戏产物。
出一个可发布的绿色版走 `node scripts/release.mjs --out-dir <目录>`
(抽取 → **全场景抓取扫描** → 验收 → 编译 exe → 装配);分步调试走
`npm run package:<档>` / `npm run verify:sweep` / `npm run verify:<档>`;
`npm run build` = 这三步串起来;要 NSIS 安装包走 `npm run tauri:build`。

**"编辑器里好的、包里坏的"第一嫌疑永远是清单漏抽**:dev 服直接托管整个 `public/`,
清单漏一条 dev 下毫无症状、包里就 404,而运行时对缺素材大多静默降级。2026-09-05 那次
(下面「已知坑」)28 个场景角色照明整份失效,三道门全绿。先查 `.build/sweep-<档>.json`。

## 输出目录是参数,不是配置

**编辑器和自动化流水线共用 `release.mjs` 这一个入口,区别只有传进去的 `--out-dir`**:
编辑器每次传同一个(覆盖上一次),自动化每次传新的(全部留档)。

输出目录刻意不进任何配置文件——它不是"这个项目怎么构建"的一部分,而是"这一次把结果放哪"。
档位差异(从哪个场景起、带不带调试设施)才在 `tools/build/build_config.json` 里,
那份是存盘的,所以**脱离编辑器也能独立构建**。

那个目录会被整体清空重写,所以有两道闸:**路径体检**(盘符根/仓库根/仓库根的上级/
`public/` `src/` 等源码树一律拒绝)+ **覆盖策略**(有上次的 `.gamedraft-build.json`
标记才直接覆盖;陌生的非空目录报错退出,要 `--force`)。

`release.mjs` 走 `tauri build --no-bundle`:只要绿色版的话,makensis 压 566 MB
要多花四五分钟,对定期自动构建是纯浪费。

实测体积(2026-08-28):开发树 `public/` 2903 MB → **发行档 566 MB**(1436 个文件,38.5 秒)、
dev 档 1359 MB。省下来的两个大头:未引用/authoring-only 的素材,以及音频转 ogg
(212 MB → 19.4 MB)。

## 权威源(读代码从哪进)

清单:`tools/build/asset_manifest.py` + `manifest_rules.json`(规则里每条都注明了 src 出处)。
装配:`scripts/package.mjs`。验收:`scripts/verify_build.mjs`。全场景抓取扫描:
`scripts/scene_sweep.mjs`(编排:起隔离 dev 服)→ `tools/build/scene_sweep.py`(QtWebEngine 驱动
+ 请求拦截 + 清单核对)。光照载荷文件名表:`src/core/lightingPayloadFiles.ts`(运行时真相源;
Python/mjs 两份镜像各有契约测试钉死)。桌面壳:`src-tauri/`。

## 硬契约

- **只读抽取。** 打包对 `public/`、`src/`、`resources/` 只读,输出只落 `release/` 与 `.build/`。
  **裁剪一律通过"不抽取"实现**,绝不搬移/删除/重组开发树里的东西——包括看起来无人引用的
  烘焙产物、备份、参考素材。开发数据的取舍是人的决定,不是打包的副作用。
  音频转码与 JSON 里 `.wav→.ogg` 的改写**只发生在 staging 副本上**。
- **`vite build` 不拷 public**(`build.copyPublicDir: false`)。默认行为会把 2.9 GB 原样转储进 dist,
  里面混着编辑器预览图、背景备份、参考图、生成脚本。因此**裸 `vite build` 的 dist 不能当游戏跑**
  (没素材),要可运行产物必须走 `package:*`。
- **清单有四个来源,少一个就是运行时 404**:
  1. `public/assets/**` 全量(文本配置,~1 MB;运行期按 id 动态加载,静态闭包不可能完备);
  2. JSON 引用闭包(复用 `asset_reference_audit` 的 `resolved_media/resolved_text`,**同一套引用语义**);
  3. 传递闭包(`anim.json`→`spritesheet`;`<img>.png`→`<img>.normal.png`;`anim.json`→同目录 `sockets.json`;
     `lighting/<背景基名>/lighting.json`→同目录**它的 `shading.mode` 要读的那张 probe 图集** + 核心/几何/可选旁挂);
  4. `manifest_rules.json` 的显式规则——**代码写死路径或运行期拼出来的**那些,静态扫描永远抓不到。
  另有 id 约定扫描(`bundleId` → `animation/<id>/anim.json`)与**注册表闭包**(2026-09-06:
  `overlay_images.json` / `prop_presets.json` 里登记的每张图,登记即引用——素材审计只在某条
  动作真用了那个短 id 时才解析它,登记但暂未引用的 14 张原本进不了包,dev 服能显示、包里静默缺)。
- **光照载荷"运行时读什么"只在一处定义**(2026-09-06):`src/core/lightingPayloadFiles.ts`
  (mode→图集表、必读/几何/可选/调试专用四组文件名、缺省 mode)。运行时按它选图集、按它的
  `fetchPayloadBytes` 取文件(缺文件**必抛**,不再把 404 正文当数据);打包展开器
  `_expand_lighting_payload` 与验收门 `lightingPayloadParity` 各持一份镜像,
  `tools/build/tests/test_asset_manifest.py::RuntimeContractTests`(解析 TS 源码)与
  `src/core/lightingPayloadFiles.test.ts`(import 两边)逐字比对。规则文件只登记
  `lighting.json` / `geometry.json` 两个**入口**;dev 档另带三张图集 + `vol_*`(F2 切档)。
  **发行档的 `never_extract` 不许再出现任何 `atlas_*.bin`**——哪张是正式档由载荷说了算,
  测试对着真实规则验这一条。
  ⚠ 2026-09-07 场景侧那三件改成 `geometry.json` / `normal.png` / **`albedo.png`**:
  灯乘的反照率成了一张烘出来的贴图(见 [scene-lighting](scene-lighting.md)),而
  `skyvis.png` 退出运行时、进了 `never_extract`——它现在只是烘 albedo 的离线输入,
  开发树里照旧有、发行包里不许有。
- **两道反向门**(清单说"要的都在" ≠ 运行时"要的都在清单里";2026-09-05 之前只有正向):
  1. `verify_build.mjs` 的**光照载荷平价**:遍历开发树 `scenes/*/lighting/*/`,按每份
     `lighting.json` 的 mode 算出必读文件,逐个查产物;开发树里有而产物没有 = fail,
     开发树本来就没有 = note(烘焙缺件,两边同样降级);发行档里出现 `vol_*` 也 fail。
  2. **全场景抓取扫描**(`scene_sweep`):起一个 `GAMEDRAFT_SWEEP_ISOLATED=1` 的 dev 服
     (命令队列恒空、快照不落盘、存档落 `local/gamedata_sweep/`——不碰人手里那份),
     QtWebEngine 逐个以 `?mode=dev&devScene=<id>` 进每个场景、对开了日夜且配了 `timeVariants`
     的场景再在页内 `advanceTimeTo` 切到每个时段,`QWebEngineUrlRequestInterceptor` 拦下
     **全部**请求,归一化后问清单:清单没有、开发树有 = **漏抽**(FAIL);开发树也没有 =
     数据缺件(只记);`sockets.json` / `*.normal.png` 的探测 = 按设计 404。
     报告 `.build/sweep-<档>.json` 记清单哈希 + `src/` 指纹;`verify_build.mjs` 只认对着**当前清单**
     跑出的报告。`release.mjs` 默认跑;清单与 `src/` 都没变、上一次全量 PASS 时**复用**上一次报告
     (全量扫描 36 场十来分钟;"网络静默"只看游戏内容请求——dev 游戏每 600ms 轮询一次命令通道,
     连它一起算的话每场都干等到上限,实测一场 5 分钟;`--force-sweep` 强制重扫,
     `--skip-sweep` 显式跳过并在标记里记 `swept:false`)。它对代码怎么拼路径
     一无所知——新加一条运行期拼出来的资源,下一次扫描就会看见。这是本管线里唯一能证明
     "清单没漏"的东西;只覆盖**进场景**这一拍(对话立绘、小游戏贴图等要交互才拉的,仍靠规则)。
- **产物里有一个不在清单里的派生文件:`assets/scene_index.json`**(2026-09-03)。它不是从开发树
  抽取的,是 `package.mjs` 装配完素材之后按**已落地**的 `assets/scenes/*.json` 现算写出的
  (`scripts/lib/scene_index.mjs`,与 vite 开发服中间件共用同一份生成器——开发服按请求现算同名 URL)。
  游戏里一切"列出全部场景"的调试入口(Dev 菜单、F2「场景」页,`src/dev/sceneIndex.ts`)都读它,
  拿不到才退回"地图节点 + game_config"那份派生清单。仓库里**没有也不该有**这个文件:一旦有人手工
  维护,新建场景就又得"记得去加一行"。验收门比对清单时它天然不在清单里,别把它当漏抽或多抽。
- **代码里新增一条拼路径的资源 = 必须同步登记规则**。已知的坑:对话立绘
  (`<slug>/<slug>_<emotion>.png`)、扎纸部件(`<part.id>.png`)、两代场景光照载荷、
  UI 图标名单、检视托底图——全是 JSON 里搜不到的。
- **dev 与发行的游戏内容完全一致**,差别只在调试设施与压缩:发行档剥 dev 直达后门
  (`?play_cutscene` 那一族是明确的发行阻断项)、不带 F2 光影切档的体积载荷(`vol_*.bin`,
  每场景 20–27 MB)、音频转 ogg。
- **发行档缺 ffmpeg 直接报错,dev 档只警告**。带着 wav 发出去等于悄悄改了交付内容;
  dev 包是工作产物,不该因为少个工具就卡住开发。
- **转码之后必须闭环断言"产物里零 `.wav` 引用"**。改写函数只扫 `assets/**`、
  只认 `audio/` 下的文件;哪天引用写进 `resources/` 下的 sidecar、或 wav 放到 `audio/`
  之外,改写就漏——文件已改名成 `.ogg`,引用还指着 `.wav`,结果是**一片静音且不报错**。
  验收门查的是"还有没有 `.wav` 文件",恰好是互补的另一半,单独哪一半都拦不住。
- **`--out` 必须落在 `release/` 之下**。那个目录会被 `rmSync(recursive, force)` 删掉重建;
  没有护栏的话 `--out .` 就是递归删当前目录、`--out public` 就是删掉 2.9 GB 素材树。
  "只读抽取"这句承诺得有代码守着才算数。
- **静态检查证明不了"能玩"**。`verify_build.mjs --serve` 起静态服务并记录每一个 404,
  真跑一遍游戏之后看 `/__verify/404`——清单漏没漏东西只有这里说了算。
  注意区分**按设计就会 404** 的那批(见 `EXPECTED_404`):动画挂点表 `sockets.json`
  是可选 sidecar,109 个包里只有 2 个有,运行时对另外 107 个的探测**必然** 404
  (dev server 上表现为 200+HTML,判据看 content-type;见 optional-asset-probe 卡)。
  不做这个区分,验收门会永远红,红久了就没人看了——那比没有门更糟。
- **文件在 ≠ 内容对**。`checkBakeFreshness` 比对载荷记录的 `background_sha1` 与包里
  `background.png` 的实际哈希,**判据与运行时的哈希门逐字同口径**——两边口径一分家,
  这道门就变成"发行前说没事、进游戏才关灯"。重画了背景没重烘光照时:
  素材审计全绿(文件都在)、零 404(路径都对),但运行时把那个场景的角色光照降级,
  画面明显不对却没有一条报错指向根因。这是所有既有门的共同盲区,只有这里查。
  ⚠ 载荷路径带**背景图名那一层**(`lighting/<背景基名>/…`);这道门自己就因为正则少写
  那一层空转过一轮,过滤后为空时它只会打印"没有载荷,跳过" ——
  **"一个载荷都没找到"必须判失败,不能判跳过**(见 [scene-lighting](scene-lighting.md) 的降级出声一条)。

## 桌面壳(Tauri)的硬约束

前四条都是"不这么做就静默坏掉"的,踩过一次:

- **`app.withGlobalTauri` 必须为 true**。v2 默认 false 且**不注入 `window.__TAURI__`**
  (v1 该字段在 `build` 下,别照 v1 抄)。前端靠这个全局判断自己在不在 exe 里
  (`persistentStore.ts` 的 `tauriInvoke`),项目又没装 `@tauri-apps/api`、不 import 任何
  Tauri 模块。关着的话:存档探测挑不到 Tauri → 退到 HTTP → 打不通 → **降级内存**,
  玩家存了档关掉就没。而且**验收门看不出来**——它把 `/__gamedraft-api/` 的 404 列为预期
  (那是给静态托管场景的豁免),坏掉的 exe 长得跟正常一模一样。
- **窗口尺寸不写死在壳里**(2026-09-06):`main.rs` 启动时读 exe 旁 `game/assets/data/game_config.json`
  的 `windowSize` 开窗(编辑器 F5 读同一字段),读不到回落 1024×768。以前写死 1280×720(16:9)而游戏
  视口是 1024×768(4:3)⇒ exe 里画面横向拉宽 25%。比例本身由前端等比信箱保证,见
  [display-viewport-and-window](display-viewport-and-window.md)。
- **窗口 URL 不写在 tauri.conf.json 里**。同一个自定义协议在
  Windows/Android 上是 `http://<scheme>.localhost/`,在 macOS/iOS/Linux 上是
  `<scheme>://localhost/`——JSON 只能写死一种,写错那种在目标平台上 webview 根本不认识
  这个 scheme,导航失败给你一张白页。改由 `src-tauri/src/main.rs` 的 `window_url()`
  用 `cfg!` 按平台拼,窗口在 `setup()` 里建。
- **NSIS 用 `installMode: currentUser`,不要 `perMachine`**。存档是"exe 旁 `gamedata/` 优先,
  不可写才退 AppData";装进 Program Files 之后,普通启动落 AppData、某次「以管理员运行」
  落 Program Files,**同一台机器两份互不相通的存档按启动方式左右横跳**——正好是这轮
  改动要消灭的那个 bug 的形态。装到用户目录下,exe 旁恒可写,便携语义才稳定。
- **`fs::rename` 之前不要先 `remove_file`**。Rust std 在 Windows 上走
  `MoveFileEx + MOVEFILE_REPLACE_EXISTING`,本来就覆盖已存在文件;先删一次反而造出了
  "旧档已删、新档还叫 `.json.tmp`"的丢档窗口(而 `read_all` 只认 `.json`)。

两个非常规但成立的选择:

- **内容不塞进 exe**。默认的 `frontendDist` 会把前端整棵树编译进二进制;这里内容 700 MB+,
  那样会得到一个巨大的单文件、编译极慢、玩家也看不见换不了。改用自定义协议
  从 exe 旁的 `game/` 读普通文件(`src-tauri/src/web_root.rs`)。
  游戏里所有 `/assets/...`、`/resources/...` 绝对路径因此**一行都不用改**。
- **存档便携优先**:落 exe 旁 `gamedata/`,整个文件夹拷走存档跟着走。

## 首次真实构建的实测结论(2026-08-28)

Windows 上跑通了一整轮 `tauri build`,几条原本只能靠文档推断的都落地了:

- **`bundle.resources` 的目录 key 不会拍平**。官方文档只保证 glob key 会平铺,
  目录 key 没有文档保证——实测保留完整层级:`game/assets/`、`game/resources/runtime/...`,
  1436 个文件、566 MB,深层中文路径(`illustrations/李天狗神仙岭大战旱魃/redraw_round2/layers/`)也在。
- **`gamedraft` 协议在 Windows 上确实是 `http://gamedraft.localhost/`**,窗口能加载到内容。
- **`withGlobalTauri: true` 生效**。判据很干净:前端启动时会调 `gamedata_read_all` 探测后端,
  那会触发 Rust 侧 `create_dir_all(exe旁/gamedata)`——**只要 exe 旁出现 `gamedata/` 目录**,
  就同时证明了内容加载成功、`window.__TAURI__` 注入成功、选中的是 Tauri 后端而非内存降级。
  这是个不用看画面就能验的信号,以后回归照用。
- 产物:`gamedraft.exe` **3 MB**(内容确实没塞进二进制)+ 旁边 `game/` 566 MB;
  NSIS 安装包 552 MB。Rust 编译 3 分 35 秒。

## 启动缺省:「从哪里开始」按档位烘进产物

游戏的引导态靠 **URL 参数 + 整页重启**表达(`src/core/EventBridge.ts`):
干净 URL = 直接进世界开新局,`?screen_title=1` = 停在标题界面且不装载世界,
`?load_slot=N` = 开局直接读那个槽,`?mode=dev&devScene=X` = dev 直达。

而**双击 exe / 打开产物首页时地址栏是干净的**。不管的话:

- 发行档每次启动都直接开一局新游戏,玩家走不到标题上那个「继续」——
  存档存在却没有入口去读,看起来就像存档没了。**这是发行阻断项。**
- dev 档想从某个场景起,也没地方说。

所以打包器按档位把一串 query 烘进产物(`scripts/package.mjs` 的 `bakeBootConfig` 写
`boot.js`),运行时当**缺省**用(`src/core/bootParams.ts`)。配置在
`tools/build/build_config.json`:dev 档 `mode=dev&devScene=dev_room`,发行档 `screen_title=1`。

三条硬约束:

- **缺省只在地址栏一个引导参数都没有时生效。** 否则玩家点「新游戏」→ URL 被清空 →
  缺省又把他送回标题,死循环。为此「新游戏」那次重启改成带显式的 `?new_game=1`
  (`NEW_GAME_PARAM`),于是"干净地址栏"只剩一个含义:**首次启动**。
- **不要把它写死在桌面壳里。** 那样只有 exe 形态生效,同一份 `game/` 用静态服务器
  托起来就没有;档位一变还得改 Rust 重新编译。壳只管开首页。
- **`boot.js` 是独立文件,不是内联 `<script>`。** Tauri 那边 CSP 是 `script-src 'self' …`,
  内联要 `'unsafe-inline'` 或 nonce,外部文件天然合规。注入位置必须在 `type="module"`
  入口**之前**——模块一执行就读这个全局。

### dev 档必须同时设 `NODE_ENV=development`

**只给 `vite build --mode development` 不够。** Vite 判 `isProduction` 看的是 `NODE_ENV`,
而 `vite build` 会把没设的 `NODE_ENV` 默认成 `production`,`--mode` 压不过它。
实测:只给 `--mode` 打出来的 dev 包,`import.meta.env.DEV` 仍是 false,整批调试设施被剔除,
**连显式 `?mode=dev` 都不认,跟发行档一模一样,而且没有任何报错**。

验收门因此加了**档位标记**检查:`src/main.ts` 把编译期的 `import.meta.env.DEV` 折叠成
字面量写进 `__GAMEDRAFT_BUILD__`,`verify_build.mjs` 静态比对它与 `--target`。
别的标记都不可靠——类名被 esbuild 压掉、`__gameDevAPI` 在 destroy 清理路径里两档都有、
`import.meta.env` 早被替换掉。匹配时**三种引号都要认**:Vite 8 的压缩器会把字符串
字面量改写成反引号模板。

**打包时不要开着那个 exe**:NSIS 收尾要动 `gamedraft.exe`,被占用会以
`failed to bundle project: (os error 32)` 结束——安装包其实已经生成了,但报错看着像整个失败。

还剩一条没验(需要能驱动原生窗口的环境,本机截图拿到的是 16x16、无法合成):

- **存档导出按钮**。`MenuUI` 的"导出存档"走 `URL.createObjectURL` + `<a download>`,
  在 Tauri webview 里下载行为需要额外处理,可能**静默无反应**。真不行就改走
  Rust 侧(`gamedata_root` 命令已经在了,可以直接"打开存档文件夹")。

## 已知坑

- `release/release/` 这个路径看着别扭,但它就是 `release/<target>/`,target 叫 `release`。
  `src-tauri/tauri.conf.json` 的 `bundle.resources` 指的就是它。
- 素材审计有 issue 时打包会**直接停**(`--strict`):引用指向不存在的文件,打出来必然 404。
- **`tauri.conf.json` 的 schema 是严格模式**,多一个属性都会让构建直接失败——
  包括 `"//": "注释"` 这种常见写法。那份配置里一行注释都放不下,
  每个非默认选项为什么这么写记在 `src-tauri/README.md`。
- **验收门比对清单时要认转码**:清单记的是源文件名(`.wav`),而发行档落地的是 `.ogg`。
  逐字比对会把 194 个音频全部误报成"没落地",真正的漏拷反而被淹掉。
- **新鲜度门里还有一处"静默跳过"的老形状**:它只认后缀是 `.png` 的背景,别的后缀走
  "记一条 note 然后跳过"。现在背景恰好全是 png,所以这条是休眠的——但它与
  "少一层目录就整批匹配不到"是同一个缺陷类(见 [scene-lighting](scene-lighting.md)
  的「降级必须出声」),换背景格式那天会静默失效。
- **静态清单证明不了完备**。它是"四来源并集减不抽取"的计算结果,漏了什么它自己不知道;
  真正的验收是**起真实产物跑一遍、把所有 404 收进报告**。清单绿 ≠ 游戏能玩。
- **2026-09-05:发行包 28 个场景角色照明整份失效,三道门全绿**。运行时 09-02 把 probe 正式档
  从 SH(mode 2 → `atlas_l2.bin`)切到八面体(mode 3 → `atlas_bin.bin`)并重烘了 29 份载荷,
  `manifest_rules.json` 停在 09-01 的口径:`atlas_bin.bin` 被当"只有 F2 才读"排除在发行档外,
  而它压根没进过候选集。运行时 `fetch(...).then(r => r.arrayBuffer())` 没判 `r.ok`,Tauri 的
  404 正文(`404 找不到:<path>`)被当图集吃进去:字节数为偶 → 补零成全黑图集 → **角色纯黑剪影、
  背景照常**(21 场);为奇 → `Uint16Array` 抛 RangeError → 整份载荷 catch 作废 → **角色不打光
  + 行走面深度场一起丢**(8 场)。两种互相矛盾的坏法同根。三道门为何全绿:清单护栏的必检名单是
  硬编码字面量、验收只做"清单→落地"单向比对、`--serve` 门从没人跑过(`verify-report.json`
  里没有 `expected404` 字段就是"没跑过"的判据),而 `npm run build` / `tauri:build` 连 verify
  都不含。修法即上面两条硬契约:文件名表收成一处 + 两道反向门 + 缺文件必抛。
  **判定包里"很多东西失效"时先看 `.build/sweep-<档>.json` 与 verify 的平价段,别先怀疑包旧了**
  (那次五个面全部 0 个文件晚于打包时刻,内容逐字节同源)。
- **验收门里"dev 设施已剥净"曾是恒真断言**:判据是类名 `DevModeUI` / `DebugPanelUI`,
  而类标识符被 oxc mangle 后永远不会出现在产物里。实测 DevModeUI 原封不动留在发行包里
  (`Game.startDevMode` 只判运行时字段)。现在判**文案字面量**,且 `Game.start` 的 dev 分支
  加了 `import.meta.env.DEV &&` 让那一支真被摇掉。
- **`release/<档>/` 清不掉(EBUSY/EPERM,文件全能改名、目录一个都删不掉)= 有进程持着目录句柄**
  (2026-09-06)。两种真实来源:① 某个 dev 服在 watch 它——`vite.config.ts` 的 `DEV_WATCH_IGNORED`
  此前没排除 `release/**`,编辑器 F5 开着就打不了包(现已排除,连同 `dist/ .build/ local/ src-tauri/target/`;
  旧的 dev 服要重启才生效);② 有人 `cd release/release/game` 起了静态服务器(cwd 锁目录)。
  找占用者:psutil 按 `cwd()` 扫一遍最快,`open_files()` 全进程扫要几分钟。`package.mjs` 现在会把这句话报出来。
- **刚装完 ffmpeg 找不到 ffmpeg**:winget 改了 PATH 但**已经在跑的 shell 拿不到新值**。
  `package.mjs` 的 `which()` 因此在 PATH 之外还会翻几个已知安装位置,省掉一次重启 shell。

## 怎么验证

`npm run build`(= package:release → verify:sweep → verify:release)应当全绿;
`verify-report.json` 里光照载荷平价与全场景扫描两段都 PASS 才算清单完备。
改了展开器/规则/文件名表还要跑 `sh scripts/py.sh -m pytest tools/build/tests -p no:cacheprovider`
与 `npx vitest run src/core/lightingPayloadFiles.test.ts scripts/lib/build_helpers.test.mjs`
(两条契约测试)。只扫几个场景:`node scripts/scene_sweep.mjs --scenes 城门口`(扫描开的是
**真窗口**,跑完自动关;离屏 QPA 下 GPU 上下文会丢、rAF 停摆、切场永远收不了尾,`--offscreen` 只作实验)。
交互才拉的资源(对话立绘、小游戏贴图)扫描覆盖不到,仍走
`node scripts/verify_build.mjs --target dev --serve` 真玩一段后取 `/__verify/404`。
