---
id: vfx-workbench
title: 粒子工作台(独立桌面应用 · 页内跑同一份运行时模拟 · 效果资产与布置库唯一写入者)
domain: editor-tools
type: mechanism
summary: 效果资产与布置库(场景 × 时段外观)唯一的作者面与写入者;页内跑的是打包进来的运行时 vfxSim 本体、喂的输入与游戏同形;相机与 gizmo 经 /vendor 原样复用轨迹台那两份;保存与推给游戏都只带"真改了的那几份"(scoped),盘上被外部改过拒写;效果改名 / 删除查全部外部引用(挂件预设、playVfx / playPropVfx、可燃物模板);光柱在这里摆(原画视图真预览);燃烧用的外部给点与可燃模板在这里配;雷的长相是雷电样式库(现画天雷的形状 / 粗细 / 灯 / 落地那一下,参数化可换),在这里改、现画预览、套用;表面材质区(水面 / 湿地)在这里画;主编辑器只显示;桌面壳零缓存
status: active
authority:
  - tools/vfx_workbench/serve.py
  - tools/vfx_workbench/assets.py
  - tools/vfx_workbench/placements.py
  - tools/editor/shared/vfx_placements.py
  - tools/vfx_workbench/bundle.py
  - tools/vfx_workbench/game_link.py
  - tools/vfx_workbench/viewer/app.js
  - tools/vfx_workbench/viewer/view3d.js
  - tools/vfx_workbench/viewer/beams.js
  - tools/vfx_workbench/viewer/inspector.js
  - tools/editor/shared/vfx_burn.py
  - tools/vfx_workbench/lightning.py
  - tools/vfx_workbench/viewer/lightning.js
  - tools/editor/shared/vfx_generator.py
  - tools/editor/shared/vfx_bolt.py
  - src/dev/runtimeVfxSync.ts
  - tools/desktop_shell.py
triggers:
  paths: ["tools/vfx_workbench/**", "public/assets/data/vfx/**", "public/assets/data/vfx_placements.json", "public/assets/data/vfx_lightning_styles.json", "src/dev/runtimeVfxSync.ts"]
  topics: [粒子工作台, vfx, 效果资产, 发射器, 群体, 巢, 刺激, 联动, gizmo, 布置, 时段外观, 发射区域, 范围区域, 光柱, 体积光, 光带, 起播错峰, 预热时长, 间隔浮动, simulation, 雷电样式, 雷的样式, 天雷, 雷符, 表面材质区, 水面, 湿地, 倒影]
  tasks: [加光柱, 调体积光, 做粒子效果, 改粒子工作台, 调群体参数, 摆巢, 加发射器, 布置粒子, 拉粒子区域, 调夜里的粒子, 调雷, 画水面]
verified_by:
  - tools/vfx_workbench/tests/test_assets_and_serve.py
  - tools/vfx_workbench/tests/test_bundle.py
  - tools/vfx_workbench/tests/test_placements.py
  - tools/vfx_workbench/tests/test_program.py
  - tools/vfx_workbench/tests/test_timing.py
  - tools/vfx_workbench/tests/test_selftest.py
  - tools/vfx_workbench/viewer/tests/selftest.js
  - tools/vfx_workbench/viewer/tests/scoped-save-selftest.js
  - tools/vfx_workbench/viewer/tests/beam-selftest.js
  - tools/vfx_workbench/tests/test_beam.py
  - tools/vfx_workbench/tests/test_burn_fields.py
  - tools/vfx_workbench/tests/test_lightning.py
  - tools/vfx_workbench/viewer/tests/lightning-selftest.js
  - tools/vfx_workbench/viewer/tests/surface-selftest.js
  - tools/editor/tests/test_scene_vfx_overlay.py
  - tools/editor/tests/test_scene_vfx_beam_overlay.py
last_governed: 2026-09-24
---

## 是什么(一句话)

策划做粒子 / 群体效果并放进场景的唯一地方:`sh scripts/py.sh -m tools.vfx_workbench`(主编辑器「工具 → 粒子工作台…」、开发控制台也有入口)。
选场景 + 时段外观(按深度展开成 3D)→ 加发射器、按模块调参 → 3D / 原画里拖原点 / 巢 / 锚点 / 区域 / 玩家 / 刺激 → 页内当场跑 →
`Ctrl+S` 一次落两份(效果 `vfx/<id>.json` 与布置库 `vfx_placements.json`)。运行时见 [[vfx-system]]。

**游戏只是预览器,主编辑器只是显示器**(制作人 09-13:"主编辑器里只负责显示,画蛇添足"):场景画布只读画区域 / 锚点 / 光柱轮廓,
场景页 vfx 块只有「显示时段外观」+ 摘要 +「刷新粒子数据」。已有工作台的领域,新的编辑需求默认落在工作台。

## 与轨迹 / 声学两台同一个模子(复用,不 fork)

`viewer/common.js`(SceneCal、**左手 lookAt**)、`gizmo.js`、`history.js`、`dropdown.js` 经 `serve.VENDOR` 白名单 `/vendor/*` 原样直供;
几何路由直接 import `trajectory_workbench.geometry`;地址发现 / 拉起 import `acoustic_workbench.game_link`;桌面壳 `desktop_shell.py`。
⚠ `list_scenes()` 字段叫 `depth` 不是 `hasDepth`;视线方向走运行时 `sceneSpace.viewDirWorld`(轨迹台 SceneCal 没有它)。

## 本地预览 = 运行时模拟本体,输入也必须同形

`bundle.py` 用仓库自带 rolldown 把 `vfxSim` / `vfxSpace` / `sceneSpace` / 几何底座 / `sceneWind` / `vfxRandom` / `vfxConfine` / `burnables` 等打成 ESM,
**缓存戳顺 import 扫整棵依赖树**(手抄清单漏过文件,页面一直跑旧包)。**别在 JS 里另写一份模拟 / 清洗 / 缺省。**
喂给模拟的输入与 `VfxSystem` 同形:场景风 + 风钟(`SceneWindState`)、活动布置的锚点 / 种子(没写 = `hashSeed(id)`)/ 数量 /
`area` **与 `confine`**、透视度量、可燃模板表(`burnTemplates`)。少一样就"不是游戏里那个"(09-12:三样都没接时纸钱 0 张动)。
⚠ 本地预览的粒子在 3D / 2D 视图里都**按发射器着色画点**:贴图、颜色曲线、受光、薄片的朝向与弯曲在台里一律看不到,
外观类改动要推给游戏看——别拿"台里没变化"判改动没生效。
⚠ 打包必须在子进程里做(pytest 进程装着仓库写保护)。⚠ Windows 上 `--serve` 同端口能起第二个(`SO_REUSEADDR`),重起前确认旧进程死了。

## 坐标对齐自证(不许绕过)

装场景后三项任一非零 → 场景芯片染红:25 个画面点过运行时 `groundWorldAt` vs 台里 SceneCal(实测 0 wu)、壳接触运行时 vs 服务端、
世界 ↔ 画面往返。另三条手性自检:M-world 是左手系,右手 lookAt 画它整张镜像且不报错(轨迹台与声学台各中过一次)。

## 硬契约(违反即 bug)

- **唯一写入者**:效果资产与布置库只有本台写;主编辑器只读(没有脏桶、不进 save_all、不进外部改动基线)。两个写入者的下场是互删。
- **布置按「场景 × 时段外观」分份、没配就没有**:顶栏「时段外观」= 基底 + 场景 `timeVariants` 的键;换场景 / 外观不丢布置改动(库是全局工作态)。
  形状 / 键序 / 查询一律用共享 `tools/editor/shared/vfx_placements.py`(与主编辑器、校验器同一份)。跨外观只拷**左栏选中的那一条**(制作人 09-16),不改"互不继承"。
- **保存与预览都按编辑范围(scoped)**:页面把工作态与载入 / 保存基线逐份(场景 × 外观)比,只提交真改了的份;服务端 `save_changes` 把这几份合进
  盘上那份、未编辑的原样保留,**盘上那份相对基线被外部改过就拒写**(页面改动留着);效果文件同样带基线,外部改过拒存。
  推给游戏的布置只收 `mode: 'scoped'`,游戏按份覆盖、其余读盘;旧协议的整库副本被拒(游戏面板提示刷新工作台)。旧桌面进程要重启才有新接口。
- **撤销 / 脏态 / 保存锁同时覆盖效果 doc 与布置库**;只存成一半时如实说哪份没存上、不清脏;脏态比键序无关的 `canonJson`。
  `Ctrl+S` 先让焦点输入框失焦再存;没改不发请求;存盘不清撤销栈。关窗 / F5 由桌面壳问页面 `__unsavedSummary()`(见 [[trajectory-workbench]]),
  光写 `beforeunload` 没用。
- **保存前过同一道形状闸门**(`assets.normalize_effect`,与校验器同口径):id == 文件名、`onHit` 指别的发射器、`subOnly` 不带 behavior、
  取值范围(`emissive`、`lightGain`、`followAnchor`、`maxDistance`、`prewarmSeconds` 0..15、`spawn.intervalJitter` 0..0.95、光柱契约)。
  `simulation` 过运行时同一份 `emitterProgramErrors`;**打开 / 归一化不改作者数据**(未知字段、数值写法、未启用的参数块原样留;旧资产不替作者写 simulation)。
  顶层键序以 `assets._ORDER` 为准。⚠ 工作态 `authoring.attach`(挂点预览)只在本台镜像里有,`types.ts` 的 `VfxEffectDef.authoring` 还没登记。
- **改名 / 删除查全部外部引用**:布置、挂件预设 `particles`、数据里的 `playVfx` / `playPropVfx`(含挂件状态动作)、可燃物模板的 `particles[].effect`。
  改名要求都已保存、有外部引用就拒绝并说去哪改;删除列出引用要确认。删布置时库里再没有这个 id 而剧情数据里有 `playVfx/stopVfx/setVfxState` / `vfx` 条件引用它,先列出要确认。
  本台不写那些外部文件。
- **检视器渲染只读**:`render()` 绝不写 doc,缺省容器只在写入闭包里补(渲染时塞空容器 = 没编辑就脏、存出多余键);
  只有真改了 doc 才标脏、拖拽合成一条历史、纯点一下 gizmo 不算编辑、装载门期间拒存——逐条照 [[trajectory-workbench]]。
- **布置的锚点就是锚点**:有活动布置时改的是布置的 `anchor`,没有才改效果的预览锚点 `authoring.anchor`(运行时忽略)。
- **粒子区域在本台两个视图都能编**:发射区域写 `area`、范围区域写 `confine.area`;顶点一选中立刻出 gizmo;去掉「限定」勾时 confine 收进会话 stash、再勾原样回来。
- **选中任何东西、在任何视图立刻出现 gizmo**,轴心在那个东西上(被制作人打回过三轮);相机与 gizmo 照 Unity。拾取取屏幕距离最近者,并列时当前选中优先。
- **下拉框一律走页内列表**(`/vendor/dropdown.js`),不许系统原生 `<select>` 弹窗(150% 缩放下越开越大、不吃配色);Ctrl+滚轮不许缩放整页。
- **单键快捷键忽略自动重复**;输入框里 Enter = 提交并离开;收起的下拉框上方向键归下拉框。
- **自检的游戏地址钉在 `127.0.0.1:9`**,临时资产 `zz_selftest_*` 前缀用完删,绝不在真资产上保存;布置库落临时目录。

## 雷电样式(2026-09-24 重做:现画天雷,对齐参考图)

雷**在游戏里现画**(不烘贴图,见 [[strike-threat]]):样式库 `assets/data/vfx_lightning_styles.json`(本台唯一写入者)里一套样式 =
形状模型 `bolt` + 参数;「套用」= 把参数写进效果的 `bolts[]`(天上那道 `sky` / 落地电弧 `ground` / 水面电弧 `water`,种子 +0/+1/+2)
与样式拥有的四层发射器 `bolt / bolt_stroke / ground_arcs / water_arcs` 的 `appearance.bolt`。自带三套:参考图天雷 / 直一点少分叉 / 多分叉。
效果里记 `generator: {kind:'lightning', style, seed, group?, built?}`(运行时忽略;形状闸门 `shared/vfx_generator.py`)。
雷符 10 道 = 组 `雷符天雷`,在检视器「雷电样式」一节一起换;旧的五套贴图样式与离线烘焙器(`lightning_rope.py` / `bake_lightning.py`)已退役。

- **参数表是服务端一份**(`lightning.SPEC`,人话名 + 分组 + wu / 像素 + 上下限),页面照它生成控件:形状、分叉、粗细与光晕(世界宽 + 屏幕下限)、
  回击加粗、落地 / 水面电弧、**雷的灯**(落点 / 雷身 / 天上,色温)、**落地那一下**(冲击风多猛多远多久、点火半径)。
- **现画预览**:检视器里一块 WebGL2 画布,左远右近两个距离(一个人多少像素写在下面),编译的是运行时同一份 `vfxBolt` / `vfxBoltGlsl`
  (经 `bundle.py` 打包);参数从服务端 `POST /api/lightning/compose` 拼出「套用之后」的 bolts 与四层(只读、不落盘),页面不另写映射。
- **改参数 / 换样式 / 另存 / 删 / 恢复预设进同一条撤销栈**,但**不算效果的脏**:「●未套用」只有「套用」才落盘(存库带基线 +
  受影响效果全部重新套用、`save_asset`)。当前效果没存就拒绝套用。
- **样式只拥有那四层**:同一形式(现画)再套保留作者调过的时间曲线 / 寿命,换形式(旧帧表 → 现画)回缺省;旧版的 `bolt_arcs` 层套用时拿掉。
  别的发射器(落点光团、火星、碎石、泥土喷溅、扬尘、水花……)归作者:改一份,点「把别的层同步给同组」(`POST /api/lightning/sync_group`)
  抄给同组其余几份,各自的样式层与种子不动。
- ⚠ **哈希按字面算会漂**:页面 JSON 把 `1.0` 写成 `1`;`_canon_num` 统一成浮点。
- ⚠ **灯的强度别按单张参考图调**:河边调到 ×3 才像,跑马梁 / 码头(深夜原画)同一套直接曝白;缺省按多数场景定,个别差异留给参数。
- 命令行:`sh scripts/py.sh -m tools.vfx_workbench.lightning --check`(过期退出码 1)/ `--reapply [ids]` / `--sync-group <效果>` /
  `--migrate-bolt`(一次性:旧贴图版 → 现画,删旧生成目录)。
- **对着参考图抓图**(不改任何资产):dev server 上无头 Chrome 开 `?mode=dev&devScene=<场景>`,Esc 连按过过场、切到参考图那套时段,
  `renderer.setViewportSize(参考图宽高)` + 相机缩放到整张图入镜、藏 UI 与主角,直接调 `Game.fireOneBolt`(只表现、不走结算),
  逐帧 `__step` 抓 34 / 67 / 200 / 500 ms,与参考图并排看。

## 表面材质(全局缺省 + 表面材质区,2026-09-24)

雷是任意地方随机落的,**不按场景调**:没画区域的地方一律用布置库顶层的**全局缺省材质** `defaultSurface`
`{reflect?, roughness?, detail?, ripple?}`(所有场景一份;检视器「表面材质区」一节最上面「没画区域的地方」四行,空 = 运行时缺省,占位里写着)。
区 `scenes[场景].surfaces`:`{id, kind: water|wet, polygon(场景坐标 wu), reflect?, roughness?, feather?}`,**场景级、所有时段共用**,
只标材质真正不一样的地方(水体、石板铺地、压在水上的栈桥和船)。落雷照出物理反光、落在水面上换水花与水面电弧
(见 [[scene-lighting]]、[[vfx-system]])。改全局缺省只提交 `changes.defaultSurface`(不带任何场景),推给游戏同样。

- 工具条 `≈`(拉一块水面)/ `⋯`(拉一块湿地)按住拖框 = 新的一块;顶点键 `area:s<块>:<点>`,与粒子区域同一套拖 / 双击边线加点 /
  Delete 或右键删点 / 方向键微移;检视器「表面材质区」一节改 id、种类、反光、粗糙度、边缘羽化(空 = 运行时缺省,占位里写着)、删、选中。
  「在画面上显示并编辑」关着时不画、不能拖。
- 后画的盖前面的(水面里画一块湿地 = 挖出一块露出来的滩);本地预览的落点表面与游戏 `surfaceKindAt` 同判据。
- 存盘 / 推给游戏都是 scoped:改了哪个场景的表面区就带那个场景的整份 `surfaces`(空数组 = 清空,盘上剥掉键)。
- 20 张室外图现有的区只剩水体与石板地(09-24 下午删掉了按参考图雷落点圈的整张湿地 / 路面区——那是按场景调雷);
  主编辑器场景画布只读显示(水面蓝、湿地青绿)。

## 燃烧与光柱在本台的部分

- **发射形状 `external`**(燃烧系统每帧给出生点):本地预览喂几个锚点周围的假点,视图与状态栏标明。
- **薄片「可燃模板」** `plate.burnable {template}`:候选只列能绑的面燃烧模板(**候选面 = 校验面**,`vfx_burn.plate_bindable_template_ids`);
  当前值不在候选里时保值展示并说原因,不静默顶替。本地预览按打包的 `resolveBurnable` 装模板真烧;「火」工具放一段火焰看纸着 → 焦黑 → 成灰。
  本台只读 `burnables/`、从不写。旧 `plate.flammable` 作废、运行时不读,检视器给「删掉」。
- **光柱**:两个把手(起点 / 终点);**3D 视图只画线框,原画视图用运行时同一份 GLSL 真预览**(台里没有显示变换与场景灯,最终亮度去游戏看);
  还被尘埃用着的光柱删不掉;没有深度载荷的场景退平面近似并黄字说明。形状闸门报错与运行时逐字同句。见 [[vfx-beams]]。

## 联动(双槽,与声学同形)

| 路径 | 方向 | 内容 |
|---|---|---|
| `/__gamedraft-api/runtime-vfx` | 工作台 → 游戏 | `{rev, writer, effectId, def, sceneId?, probe?, placements?{mode:'scoped', library, sceneId, phase}, phaseRequest?}` |
| `/__gamedraft-api/runtime-vfx-status` | 游戏 → 工作台 | 场景 / 时段 / 外观 / `placementsApplied` / 实例状态 / stats / 玩家脚点 / **spaceKind** / bootId;按页分桶 |

- 游戏侧 `runtimeVfxSync.ts` 三个防死机制一个不少:每发挂超时、连不上指数退避到 3 s、`statusLine()` 带收发计数。
- 游戏侧套用:定义逐字没变不重建实例;撤覆盖时绕过 JSON 缓存从盘上重读(不回退开局缓存)。**回传的 `spaceKind` 要看**,planar 时预览的几何判据全是空的。
- **送到了才算推过**;游戏页刷新(`bootId` 变)立刻补推。`phaseRequest` / `probe` 的序号"粘住"重发,游戏只认比记住的大的。
- 「让游戏切到这个时段」:游戏在别的场景时先拉到本场景、进来再核外观;游戏已是这套外观就不发。
- ⚠ **vite 槽插件会剥掉不认识的字段 / 形状不对回 400**:新字段必须在 `vite.config.ts` 的 `runtimeVfxApi` 里显式透传。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/vfx_workbench -q -p no:cacheprovider   # 资产 / 布置库 / scoped 保存 / 改名删除连带 / program / timing / 打包 / 真 HTTP
sh scripts/py.sh -m tools.vfx_workbench --selftest                       # 无头桌面壳交互层,有 FAIL 退出码 1
sh scripts/py.sh -m tools.vfx_workbench --check                          # 全部效果资产 + 布置库过形状闸门
```

`--selftest` 在 offscreen + ANGLE/SwiftShader 桌面壳里装真页面(`viewer/tests/` 下 selftest / scoped-save / timing / pipeline / beam /
lightning / surface 各套):坐标对齐与手性、相机手势、gizmo、保存往返与键序、保存锁、下拉框、薄片输入、布置与区域、燃烧字段、光柱、
雷电样式(现画预览真画出了雷、套用、同步同组)、表面材质区(真拖框、顶点、检视器、scoped 推送、存盘删光)。
**改 viewer 下任何东西先跑它**;新抓到的坑往里加一条 `ok()`。主编辑器只读画布护栏见 `test_scene_vfx_overlay.py`。
