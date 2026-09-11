---
id: acoustic-workbench
title: 声学工作台(独立桌面应用 · 场景 3D 展开 · 游戏只是预览器)
domain: editor-tools
type: mechanism
summary: 回音几何唯一的作者面与唯一写入者;把场景按深度在世界空间展开成 3D,反射面/听者/声源以 3D 物体贴着画里的崖壁摆,像 Unity 那样漫游与操作;抽头与 IR import 运行时同一份打包;经 dev server 双槽实时推给游戏预览、试听也在游戏里播;桌面壳零浏览器缓存;--selftest 是交互层回归门
status: active
authority:
  - tools/acoustic_workbench/serve.py
  - tools/acoustic_workbench/spaces.py
  - tools/acoustic_workbench/bundle.py
  - tools/acoustic_workbench/game_link.py
  - tools/acoustic_workbench/viewer/app.js
  - tools/acoustic_workbench/viewer/view3d.js
  - tools/acoustic_workbench/viewer/mathx.js
  - tools/desktop_shell.py
triggers:
  paths: ["tools/acoustic_workbench/**", "public/assets/data/acoustic_spaces.json"]
  topics: [声学工作台, 回音, 反射面, 崖壁, 距离缩放, 3D 展开, 漫游, gizmo, 试听, 声学联动]
  tasks: [摆回音, 改声学工作台, 加反射面类型, 改联动, 新空间]
verified_by:
  - tools/acoustic_workbench/tests/test_spaces_and_serve.py
  - tools/acoustic_workbench/viewer/tests/selftest.js
  - src/audio/acousticSpacesData.test.ts
last_governed: 2026-09-08
---

## 是什么（一句话）

策划怎么做出一个场景的回音：开**声学工作台**（`sh scripts/py.sh -m tools.acoustic_workbench`，主编辑器
「External tools → 声学工作台…」或场景属性页 `acousticSpace` 旁的按钮），选一个场景装进来（按深度在世界空间展开成
3D），**直接在画里的崖壁上按下拖一段**就是一面反射面，像 Unity 那样漫游、移动 / 旋转 / 缩放，
右栏调吸收 / 粗糙 / **距离缩放**，按试听键游戏里立刻响，`Ctrl+S` 落 `acoustic_spaces.json`。
运行时那一半见 [[scene-acoustics]]。

**游戏只是预览器**（制作人 2026-09-08 定）：编辑与保存都在这里；游戏 F2 声学页只剩状态与试听键。
脱离游戏也能编辑保存（抽头 / IR 本地照算），只是听不到、看不到真实听者。

## 作者面怎么用

- **漫游（Unity 场景视图那一套；与轨迹工作台 `view3d.js` 同一份手势表与相机基，2026-09-11 对齐，本工具 `view3d.js` 文件头是完整表）**：
  右键拖 = 环视（机位不动转头）；按着右键时 WASD/QE 飞（Shift ×3、滚轮调速；飞行键在 `window` **捕获阶段**被 `view3d._keyDown` 吃掉，
  `app.onKey` 另有 `capturesKeys()` 保险——松开右键 Q/W/E/R 才是工具键）；Alt+左键 = 绕目标点环绕、中键 / 空格+左键 = 平移、
  滚轮 = **朝光标缩放**（光标下的地面 / 壳点在屏幕上不动）、Alt+右键 = 推拉；`F` 对准选中、`Home` 看全景、双击物体 = 选中并对准。
  右上角坐标架：点臂 = 从那一侧正交看（`ortho()` near 取负，机位背后也画；拾取仍走同一套 `inv(mvp)` 射线，`_reach()` 让正交下射线够得着地面），
  点中心 = 透视 ⇄ 正交（目标深度上画面尺寸不变：`orthoH = dist·tan(fov/2)`）。相机模型 = 目标点 + 距离 + yaw/pitch（`_eye = 目标 − forward·dist`），不再存机位。
- **工具**：`Q` 选择（点选 / 左键空白拖框选 / Shift、Ctrl 加减选）、`W` 移动、`E` 旋转、`R` 缩放——三者在选中物上出现**变换 gizmo**
  （轴心：单面 = 面中心，多选 = 包围盒中心，听者 / 声源 = 点本身；**点只给移动**，旋转 / 缩放对一个点没意义）：
  移动 = 红 X / 蓝 Z 箭头沿轴（a、b 一起走）、绿 Y 箭头 = 高程（墙底高程 `y` / 水平面高度 / 点的 `y`）、三块小方块沿面、中心 = 贴地挪
  （听者 / 声源跟着行走面走）；旋转 = 绿环绕竖直轴（`Geo.rotate` 绕轴心）；缩放 = 轴末端单轴（X / Z 拉伸端点，Y = 面高、底不动；全是水平面时不给 Y）、
  中心等比（`Geo.scaleLength` + 面高同倍）。拖动时按住 `Ctrl` 吸附（10 wu / 15° / ×0.1），读数跟着光标；每 tick 从手势起点的字段快照重来再套
  累计量（`_snapSel / _gzApply`，字段映射全在这两处），3px 死区，**纯点一下不算编辑**。
  `B` 加崖壁、`N` 加水平面（水面 / 岩檐，在地面上拖一条边，`height` 当宽）、`L` 放听者、`P` 放声源。任何工具下点到物体都选中它。
- **直接把手（不经 gizmo）**：拖反射面本体 = 按当前工具移动 / 旋转 / 缩放（Ctrl 同样吸附）；拖听者 / 声源 = 贴地走（Alt 或没有行走面场时在水平面上走）；
  单选一面时还有端点 A/B（改形状）与 ▲（墙的面高，放在顶边靠 A 那侧四分之一处——正中就是 gizmo 的 Y 轴，叠着谁也点不到谁）。
  把手比 gizmo 先命中（小目标挡不住整条轴；反过来轴会把把手整个盖死）。旧的中心把手 / ▼ 底高程 / 听者 ▲ 已并入 gizmo。
  方向键微移（Shift ×10），`Delete` 删，`Ctrl+D` 复制。
- **加崖壁的落笔吸附**：射线先打深度壳（画里的崖壁本身），打不到再打地面；底高程取两端较低者，面高按长度给个起点。
  新面自动把 A→B 摆成从听者看去左→右。
- **右栏**：反射面检视器（名字 / 类型 / 高程 / 高 / 吸收 / 粗糙 + 离听者距离）、整体（说明 / **距离缩放（对数滑条）** /
  耳高 / 反射阶 / 尾长尾强 / 立体宽 / 气温 / 遮挡）、数据（作者场景、绑定它的场景）、抽头表、IR 波形。
  距离缩放行下一句常显「1 wu = ? mm；画里 1 米 = 声学里 ? 米」。
- **左栏**：反射面清单（离听者米数、首回秒数、被挡）、听者（显示绑定）、声源清单（离听者米数，「▶ 试听」标出试听从哪个发出）、
  图层开关（场景 / 压暗 / 2 米网格 / 抽头路径 / 游戏听者 / 出生点与 NPC）、游戏回传状态（场景 / 挂着谁 / 听者：绑到谁 +
  绑定来自哪一层 + 耳点米数 / 坐标对齐 / 抽头 / 出声：主输出最近 3 秒峰值 / 音频）。
- **听者绑定在这里设**（选中左栏「听者」）：跟玩家 / 跟相机 / 跟 NPC〈作者场景的 NPC 清单〉/ 钉在作者点，写进空间
  `listenerBinding`（**一律写显式**；新建的空间生来就是 `player`。没写时运行时按空间级缺省 = 跟玩家，脚步配置的
  `listener` 只在场景**没有**声学空间时兜底）。跟 NPC 但还没选：不算坏数据，运行时回落玩家并回报 `targetMissing`，
  检视器黄字。场景 JSON 若另设了 `acousticListener`，检视器黄字提示"游戏以场景的为准，去主编辑器清掉"。
  游戏回传的听者（绿）画在它实际所在处：脚点 + 耳点，标出「游戏听者·玩家 / 相机 / NPC」。
- **抽头 / 直达按谁算**：游戏在这个场景时按**游戏里活的耳点**算（抽头表头写「按游戏活听者」，3D 路径也从那里画，
  耳点挪够远才重算）；游戏不在就按作者态听者。试听状态栏也注明是按哪个算的。
- **声源有位置**（v3）：`P` / 「加声源」点地面放一个发声点（可放多个，`sources[]`），检视器里改名 / 发声高度（缺省耳高）/
  「从这里试听」。**选中哪个声源，试听就从它发出**（选中听者 = 自己喊；选反射面不动；试听来源按声源 id 记，
  删了 / 撤销了自动回到自己喊）：抽头表与 3D 路径按它算（发声点 → 反射点 → 耳），另画直达线（青）；
  检视器与抽头表头显示直达声（长度 / 延迟 / 增益 / 声像 / 被挡 / 超出最远）。「试听改为自己喊」回到听者自己发。
  「直达声」一节调 `direct` 参数（参考距离 / 衰减 / 最远 / 声像宽，声学米）——脚步、NPC 在游戏里就是这样的声源，同一套参数。
- **试听有出声证据**：试听序号由服务端发（页面刷新后从 0 数起会被游戏当旧序号吞掉）；按下 2.6 秒后先看游戏回传的
  `probeSeqPlayed`（游戏**真起播**了才推进：解码完、没超出最远距离），再看 `outputPeakDb`（只量空间音总线，BGM 冒充不了）：
  绿字「游戏出声了 ✓ 空间音峰值 −x dBFS」；否则红字分两种——游戏没播这次序号、或起播了但空间音一片静默（音量 / 输出设备）。
  发布被拒（定义没过校验）时芯片红字「游戏没收到这份」，不被心跳冲掉。
- **顶栏**：空间 新建 / 复制 / 改名（被场景绑定着的拒绝，场景 JSON 只有主编辑器写） / 删除；场景 + 时段背景；
  「▶ 拉起游戏进本场景」；撤销重做；保存；四个干声试听键；联动开关 + 游戏地址 + 状态芯片。
- **顶栏那颗按钮按现状换脸，作者按了才动，不硬同步**（`renderLaunchButton`）：没游戏 →「▶ 拉起游戏进「X」」；
  游戏在别的场景 →「⇄ 游戏切到「X」」；游戏已在本场景 → 灰掉。工作台换场景**不会**自动把游戏切过去（制作人 2026-09-08）。
- **拉起 / 切场景**（`game_link.GameLink.launch`，四条路按现状选）：游戏页已在跑 → 运行时命令队列
  `debugSwitchScene`，命令带 **`targetBootId`**（只指挥槽挑出来的那页，多开页签时其它页把命令留在队列里；实测 2 秒切到）；
  dev server 在跑但没开页 → **专用预览窗**打开 `?mode=dev&devScene=<场景>`（`tools/dev/game_preview.py`：本机 Chrome/Edge
  + 专用 `--user-data-dir` + `--app=` + 免手势音频 / 不后台降级 / 禁缓存的开关；找不到 Chromium 才退系统浏览器并明说）；
  什么都没有 → 让开发控制台 `/api/action open_dev_entry`（它盯着 vite 输出、管进程；它开页也走同一个预览窗），后台线程等控制台报出
  `gameUrl` 再把联动地址跟上；控制台也没开 → 工作台自己 `python -m tools.dev game start`（detached），等 5173 上
  声学槽位应答再开页。`forceOpen`（顶栏「⧉ 专用窗重开」，只在游戏页跑在普通浏览器里时露出）= 游戏明明在跑也另开预览窗。
  进度写 `launchNote`，随状态轮询进页面。游戏地址连不上时每 3 秒重新发现一次
  （环境变量 > 控制台 `/api/state` > `devstate.json` > 5173），显式填过地址的不动。
- **状态槽按页存**（vite `pickAcousticsStatusPage`）：作者的旧页签 + 新拉起的预览窗会同时回传，以前整份覆盖打架，
  芯片每秒在两种状态间跳。现在 6 秒内有心跳的里面挑**最新开的**那页当"游戏"，其余列在左栏「⚠ 多开」让人关掉；
  每页带 `bootId` / `href` / `startedAt` / `autoplayAllowed`（免手势环境探针，见 scene-acoustics「音频保活」）。
- `--selftest` 把游戏地址指到死端口：自检会往槽里发临时空间和试听，正在预览的人会听到 / 看到它。
- **入口**：开发控制台工具栏「声学工作台」（`tools/dev_console/app.py` TOOLS）、主编辑器 External tools 菜单、
  场景属性页按钮、`tools/dev/launch.py` 的 `acoustic-workbench`。
- 3D 里画：贴图三角网、2 米地面网格、墙（半透明四边形，亮度按吸收）、水平面（青色矩形）、听者（蓝，脚点 + 耳朵）、
  声源（粉）、抽头路径（耳朵 → 反射点：一阶橙、二阶紫、被挡红）、游戏里真实听者（绿，只在游戏与工作台是同一场景时画）、
  出生点 / NPC 标记、把手符号与文字叠加。

**它是桌面应用**：入口是桌面窗口（`tools/desktop_shell`：纯内存 profile、NoCache、服务端 `no-store`）；
`--serve` 只是给自动化的裸服务。单实例；第二次 `--open <id>` 把已开着的窗口切到那个空间。

## 权威源（读代码从哪进）

`serve.py` = 路由与保存出口；`spaces.py` = 库的读写、v2 形状收束（`normalize_def`）、id 护栏、原子写 + `.bak`；
`bundle.py` = 用仓库自带的 rolldown 把 `src/audio/acousticSpace.ts` 打成 ESM（`viewer/_gen/`，不入库，按源 mtime 缓存）；
`game_link.py` = 与游戏 dev server 两个槽位的代理（页面不直接跨源 fetch）+ 切场景命令入队；
`viewer/app.js` = 文档 / 撤销 / 检视器 / 联动轮询 / 保存；`viewer/view3d.js` = WebGL2 渲染、相机、拾取、把手与拖拽；
`viewer/mathx.js` = SceneCal（与轨迹工作台 `common.js` 同一份数学）、射线、`Geo`（反射面几何编辑纯函数）。
场景 3D 几何直接 import 轨迹工作台的 `SceneGeometry`（同一份网格 / 高度场 / 深度壳接口，不复制）。

## 硬契约（违反即 bug）

- **本工作台是 `acoustic_spaces.json` 唯一的写入者**。F2 直接存盘的 vite 接口已删；主编辑器只读它做候选与校验。
- **抽头 / IR 不在 JS 里镜像**：只 import `/gen/acoustic.bundle.js`。打不出包（没 node）工作台照常摆几何、存盘，
  页面说明「本地不显示抽头」。
- **v2 形状**：wu + `distanceScale` + `earHeight` + `authoring.sceneId`；`normalize_def` 拒 `distanceScale ≤ 0`、
  端点重合、`height ≤ 0`、吸收 / 粗糙越界；整数不漂成 float，小数三位。
- **发给游戏的就是校验过的落盘形**（`/api/link/publish` 先 `normalize_def`），与游戏侧形状闸门同口径。
- **只有真改了 doc 才标脏**；拖拽合成一条历史；撤销 / 重做后重算 + 重发；检视器渲染只读（拖拽中只刷数字不重建控件）。
- **保存锁**：保存在飞期间又改了 doc，返回后不清脏、状态栏说再按一次；磁盘操作一条链（`runIO`）。
- **装载门**：换场景期间遮罩 + `#app` inert；场景数据全部到齐一次性提交；序号守卫作废旧装载。
- **联动**：文档改动 120ms 防抖发一次；游戏刚接上或换了地址立刻发；每 3 分钟续一次（槽 5 分钟新鲜期）；
  试听 = 序号 +1 立刻发；状态 400ms 拉一次；游戏听者只在同一场景时画进 3D。
- 反射面几何变换全在 `Geo`（平移 / 绕枢轴旋转 / 以枢轴缩放长度 / 朝向听者），多选以包围盒中心为轴。

## 坐标：工作台的世界就是运行时的世界（不靠口头保证）

- M-world 是**左手系**：x 画面右、Y 上、**Z 进画**（q 翻过 Y 后 z 仍是纵深，`R` det=+1 保手性）。3D 视图的相机基按左手系搭：
  `mathx.js lookAt` 取 x = z × up（基 det = −1），`view3d.js _forward` yaw=0 看向 +Z、右 = up × forward。
  拿 OpenGL 右手那套 lookAt 画它，整张画面左右镜像、转头 / 平移 / 飞行全反，而且**不报错**——第一版就是这样
  （2026-09-08 制作人抓到）。轨迹工作台 2026-09-10 也中了一次，同样改成左手 lookAt；现在两边相机基是同一套
  （`_forward / _right / _camUp / _eye`，上向量别叫 `_up`——那是 mouseup 处理器），改一边要同步另一边。
- **自证**：`bundle.py` 把运行时 `src/utils/sceneSpace.ts`（画面点 ↔ M-world 的唯一实现，游戏听者就是它算的）与
  `acousticSpace.ts` 一起打进包。页面装完场景跑 `checkAlignment()`：25 个画面点与出生点 / NPC 分别过运行时 `groundWorldAt`
  与工作台 `SceneCal` / 服务端算的 world；网格顶点经运行时 `worldToScene` 投回画面对自己的 uv（允许 1 px）；视线方向两边点积。
  镜像 / 错基 / 错尺任何一环 Δ 都是几十上百 wu：场景芯片红字 + 状态栏报错。实测 跑马梁：画面点 Δ0、标记 Δ0.00003、网格 Δ2.8 wu（半像素）。
- **活证据**：游戏回传的听者带「画面点 + 它自己算的世界点」，左栏「游戏 · 坐标」行拿同一画面点过本地换算再比：<5 wu ✓，
  ≥40 wu 红字「不是同一套坐标」。这条比的是游戏自己的基 / 尺 / 行走面栅格，离线自证覆盖不到的那部分。
- 自检 S1b 钉住四件事：画面右在屏幕右、+Y 在上；画里靠右的点 3D 里也靠右；右键右拖向右转、中键右拖世界右移、D 键右飞固定点左移。
  S4c 钉相机手势（右键环视机位不动 / Alt+左键环绕目标不动 / 中键与空格平移朝向不变 / 滚轮缩放光标下点不动 / 右键+E 飞行键不漏给工具键表 /
  坐标架正交仍能拾取地面 / F 对准 / 框选 / 双击对准），S4 钉 gizmo（单轴只动一个分量、Ctrl 吸附是 10 wu / 15° / ×0.1 的整数倍、中心贴地、
  绿环保长度与中点、等比长度面高同倍、点只给移动、纯点不入历史）。2026-09-11 变异过一次：`_right` 反号 ⇒ 三条相机判据变红，判据是真会失败的。

## 已知坑

- **`hidden` 属性压不过按 id 写的 `display:flex`**（见下）；**右手 lookAt 画左手世界 = 整体镜像**（见上一节）。两者都是"看着能用、
  全程不报错"，只能靠看**算出来的**东西钉：computed display / elementFromPoint、投影后的屏幕 x。

- **rAF 在隐藏页 / 无头壳里不跑**：飞行步进用 `setInterval(16ms)`，松开右键即停；别改回 rAF（自检会抓）。
- **相机上向量别叫 `_up`**：mouseup 处理器已经是 `_up(e)`，class 里后定义的静默覆盖前者，画面直接炸——叫 `_camUp`。
- **自检里沿轴抓 gizmo 先用 `_hit` 核实**：端点 / ▲ 把手比轴优先命中，轴线 62% 处恰好叠着把手就抓成「改端点」（S4 第一版就撞上）；
  `along()` 换几个比例直到 `_hit` 回的是那根轴。合成键盘事件可以只给 `key` 不给 `code`（`keyCode()` 兜底），S7 故意走这条路。
- **把手命中结果里 `kind` 会被把手自己的 `kind` 盖掉**：`Object.assign({}, hd, {kind:'handle', hkind})`，顺序反了所有把手都拖不动（第一版就是）。
- **对数滑条 step 0.01 会把值量化**（30 → 30.2），断言留一档容差。
- **`hidden` 属性压不过按 id 写的 `display:flex`**：`#busy` / `#dialog` 两层遮罩从开页起就一直盖在画布上（两层压暗 + 正中一个空框，
  画布一个点都点不到），而 `el.hidden` 读出来照样是 true。页首 `[hidden]{display:none!important}` 兜底；自检 S1 / S7 看的是
  **算出来的** display 和 `elementFromPoint` 下面到底是谁，别只断言属性（2026-09-08 制作人开页就撞上）。
- **浏览器面板隐藏时 `innerWidth` 为 0**：在那儿跑自检拾取全空；交互回归一律走 `--selftest`（Qt 无头壳有真实窗口尺寸）。
- 检视器里别按序号取控件：选中反射面时前面还有吸收 / 粗糙两条滑条。
- 六个回音场景（崖墓 ×5、跑马梁）2026-09-08 才第一次烘深度：`depthConfig` 落进去 = 第一次装上深度碰撞墙，
  `audit-walkable` 要过；照明实验室 `pipeline.py` 以脚本方式跑时的两处相对 import 已改绝对（否则 probes 阶段炸）；
  物体识别的 SAM 权重实验室强制离线载入，缓存里没有要先预下载。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/acoustic_workbench -q -p no:cacheprovider   # 库 / 服务 / 联动（假 vite）
sh scripts/py.sh -m tools.acoustic_workbench --selftest                        # 交互层：83 条，~13s（含坐标对齐、手性、Unity 式相机与 gizmo 手势、拉起按钮三态）
npx vitest run src/audio src/dev                                               # 运行时尺度语义 / 同步规则 / 线上数据
```

`--selftest` 在无头桌面壳（offscreen + ANGLE/SwiftShader-WebGL）里装真页面，注入 `viewer/tests/selftest.js`：启动、坐标对齐与手性、渲染只读、
真实拖拽加崖壁、变换 gizmo（S4：单轴 / 吸附 / 贴地 / 绿环 / 等比 / 点只给移动 / 纯点不入历史）+ ▲ 与端点把手各一条历史、
相机手势（S4c：环视 / 环绕 / 平移 / 朝光标缩放 / 飞行键不漏 / 正交 / F / 框选 / 双击）、检视器数字与滑条、距离缩放 ×10 ⇒ 延迟 ×10、
保存往返与保存锁、复制 / 删除 / 键盘、脏时切空间的页内对话框、无游戏时试听给人话、换场景不丢文档 + 撤销跨换场。
改 viewer 先跑它，新抓到的坑往里加 `ok()`；改相机基要顺手变异一次确认判据会红。
真机联调：起游戏 dev（`?mode=dev`）+ 工作台 `--game-url`，看芯片变「游戏在「X」，已套用#N」、游戏 F2 声学页联动行「收N」、
3D 里出现绿色游戏听者。
