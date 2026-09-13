---
id: vfx-workbench
title: 粒子工作台(独立桌面应用 · 页内跑同一份运行时模拟 · 效果资产唯一写入者)
domain: editor-tools
type: mechanism
summary: 效果资产唯一的作者面与唯一写入者;3D 里摆发射器 / 巢与活动域 / 锚点 / 玩家 / 刺激,页内跑的是打包进来的运行时 vfxSim 本体(不是镜像);相机与 gizmo 经 /vendor 原样复用轨迹台那两份、不 fork;双槽实时推给游戏预览;桌面壳零缓存
status: active
authority:
  - tools/vfx_workbench/serve.py
  - tools/vfx_workbench/assets.py
  - tools/vfx_workbench/bundle.py
  - tools/vfx_workbench/game_link.py
  - tools/vfx_workbench/viewer/app.js
  - tools/vfx_workbench/viewer/view3d.js
  - src/dev/runtimeVfxSync.ts
  - tools/desktop_shell.py
triggers:
  paths: ["tools/vfx_workbench/**", "public/assets/data/vfx/**", "src/dev/runtimeVfxSync.ts"]
  topics: [粒子工作台, vfx, 效果资产, 发射器, 群体, 巢, 刺激, 联动, gizmo]
  tasks: [做粒子效果, 改粒子工作台, 调群体参数, 摆巢, 加发射器]
verified_by:
  - tools/vfx_workbench/tests/test_assets_and_serve.py
  - tools/vfx_workbench/tests/test_bundle.py
  - tools/vfx_workbench/tests/test_selftest.py
  - tools/vfx_workbench/viewer/tests/selftest.js
  - tools/editor/tests/test_scene_vfx_area.py
last_governed: 2026-09-13
---

## 是什么(一句话)

策划怎么做出一个粒子 / 群体效果:开**粒子工作台**(`sh scripts/py.sh -m tools.vfx_workbench`,
主编辑器场景页的 vfx 块旁、开发控制台工具栏也有入口),选一个场景装进来(按深度展开成 3D),
左栏加发射器、右栏按模块调参、3D 里拖发射器原点 / 巢与活动域 / 锚点 / 玩家 / 刺激点,
**页面里当场跑起来看**,`Ctrl+S` 落 `public/assets/data/vfx/<id>.json`。
运行时那一半见 [[vfx-system]]。

**游戏只是预览器**(与声学台同一条):编辑与保存都在这里;游戏 F2「粒子」页只剩状态与刺激键。
脱离游戏也能编辑保存(本地预览照跑),只是看不到真实光影与真实玩家。

## 与轨迹 / 声学两台是同一个模子(**复用,不 fork**)

| 复用的东西 | 怎么复用 |
|---|---|
| `viewer/common.js`(SceneCal、**左手 lookAt**、射线与投影)、`gizmo.js`(GZ / Gizmo 全套)、`history.js`、`dropdown.js` | 经 `serve.VENDOR` 白名单路由 **`/vendor/*` 原样直供页面**——不拷贝、不 fork。声学台内联 fork 过一份 GZ,那是已知欠账,这里没有加第三份 |
| `trajectory_workbench.geometry`(SceneGeometry / list_scenes)与 `serve.get_geometry / scaled_background` | Python 侧直接 import,几何路由与轨迹台同一套、共用同一份 LRU 缓存 |
| `acoustic_workbench.game_link` 的地址发现 / 拉起 / 切场景 | 直接 import,不做第三份 |
| `tools/desktop_shell.py` / `atomic_io.py` / `dev.game_preview` | 原样 |
| vite 的 `pickAcousticsStatusPage`(状态槽按页分桶) | 直接借用,规则逐字相同 |

⚠ 两个已踩的复用坑:`list_scenes()` 的字段叫 **`depth`** 不是 `hasDepth`(照声学台写会把所有场景
静默标成"无深度");轨迹台的 `SceneCal` **没有** `viewDirWorld`(那是声学台 `mathx.js` 才有的),
视线方向一律走运行时 `sceneSpace.viewDirWorld`。

## 本地预览 = **运行时模拟本体**,不是镜像

`bundle.py` 用仓库自带 rolldown 把 `ENTRY_MODULES`(`vfxSim` / `vfxSpace` / `sceneSpace` /
`depthShellField` / `groundHeightfield` / `sceneWind` / `perspectiveScale`)打成 ESM
(`/gen/vfx.bundle.js`,落 `viewer/_gen/`,不入库)。**缓存戳顺着值 import 现场扫整棵依赖树**
(`bundle.sources()`,`import type` 不算),不是手抄清单——手抄清单漏过 `vfxPlate.ts` / `sceneWind.ts`,
只改它俩页面就一直跑旧包。
页面装完场景后用 `/api/scene_ground` + `/api/scene_shell` 在 JS 里建 `SceneSpaceGeometry` 与
`DepthShellField`,`createFieldVfxSpace`,然后 `new VfxInstanceSim(...)` **真跑**。
**别在 JS 里另写一份模拟**:两份必然漂,而且漂了一处都不报错。

**喂给模拟的输入也必须与 `VfxSystem` 同形**(模拟是同一份,输入少一样照样"不是游戏里那个"):

| 输入 | 游戏 | 工作台 |
|---|---|---|
| 场景风 + 风的钟 | `Game.sceneWind`(`SceneWindState`)→ `ctx.wind / windTime` | 场景描述带 `wind`,页面 `new rt.sceneWind.SceneWindState()`;钟随本地预览推进,重建 / 重置归零(确定性含风) |
| 粒子区域 | 实例 `area` + `confine` → `VfxInstanceSim` 第 7 参 `{area, confine}` | 本场景里引用该效果、圈了 `area` 的第一个实例,**`confine` 一起带上**(2026-09-13 补:只带 `area` 时工作台里纸钱照样飞出框,和游戏不一样);没有 = 锚点周围圆盘(状态栏写明) |
| 透视度量 | `perspectiveScaleResolver.scaleAt` → `createFieldVfxSpace({perspective})` | 同一个 `createPerspectiveScaleResolver(scene.perspectiveScale)` |

⚠ 2026-09-12 实测:三样都没接时,纸钱(薄片只吃场景风)520 张在工作台里 **0 张动**、铺在出生点周围而不是
实例圈的山顶、尺寸不按透视折——制作人原话"本地预览根本没效果"。接上后跑马梁 6 s 内 123 张被吹动、
阵风顶上 13 张离地(与游戏实测同量级);**无风时仍有 ~27 张**在坡上自己滑,那是重力,不是 bug。
状态栏:`风 N wu/s` / `无风`、`薄片 离地 / 醒`、`区域=实例「…」`;有薄片而本场景没有 wind 时整行变黄警告。

⚠ **打包必须在子进程里做**:`tools/testing/repo_write_guard.py` 装在 pytest 进程里,而 bundle 要往
工作树内的 `viewer/_gen/` 写 —— 测试里直接 `ensure_bundle(force=True)` 必被 `RepositoryWriteBlocked` 拦。

⚠ **Windows 上 `--serve` 同端口能起第二个**:`ThreadingHTTPServer` 开着 `allow_reuse_address`,
Windows 的 `SO_REUSEADDR` 允许两个进程同时 LISTEN 同一端口,「端口已被占用」那条永远不触发,
请求落到**旧进程**上——改完服务端代码"重启"验证,看到的还是旧行为。重起前先
`netstat -ano | grep :<端口>` 确认旧的死了。

## 坐标对齐自证(不许绕过)

页面装完场景跑三项,任一非零 → 场景芯片整块染红 + 状态栏报错:

| 判据 | 比什么 | 实测 |
|---|---|---|
| `dPts` | 25 个画面点过**运行时的** `groundWorldAt` vs 工作台 `SceneCal.sceneToWorldGround` | **0 wu** |
| `dPen` / `dNormal` | 壳接触点过**运行时的** `shellContactAt` vs **服务端** `SceneGeometry.shell_contact` | 6.9e-5 wu / 1−dot = 7e-8 |
| `dRound` | 世界 → 画面 → 世界往返 | 1.9e-5 wu |

**手性**另有三条(自检 S3):画面右的偏移必须投到屏幕 +x、+Y 必须投到屏幕上、画里靠右的点 3D 里也靠右。
M-world 是左手系,右手 lookAt 画它**整张镜像且不报错**——轨迹台与声学台各中过一次。

## 硬契约(违反即 bug)

- **本工作台是 `assets/data/vfx/` 唯一的写入者。** 主编辑器只读它(候选 / 校验),没有脏桶、
  不进 save_all、不进外部改动基线。两个写入者的下场是互删。
- **主编辑器那一侧的三个口子**(2026-09-11 接上,照轨迹工作台逐条同构):
  「工具 → 粒子工作台…」起进程、「工具 → 重读粒子资产」手动同步、场景页 vfx 实例那一栏的
  「在粒子工作台中打开…」带着当前 `effect` 起进程。自动同步挂在与轨迹同一处:
  工作台进程退出、或主窗重新获得焦点时静默 `reload_vfx_from_disk()`(盘上没变就什么都不做)。
  ⚠ 接上之前 `ProjectModel.reload_vfx_from_disk` **全仓零调用者** —— 工作台里新建的效果
  在场景页的 `effect` 下拉里永远不出现,而且不报任何错。
- **场景页那一栏有实例就自己展开、标题带条数**(`世界空间效果 vfx（粒子 / 群体）· 2 个实例`)。
  默认折叠 + 标题不带条数 = 场景里明明摆了东西、属性页上看过去只有一行折起来的标题,
  作者的结论是"这编辑器根本没有粒子配置"(2026-09-11 制作人原话)。本页灯光 / on_enter
  早就是 `set_expanded(bool(有数据))`,照那条来。
- **场景页的「粒子区域」**(2026-09-13,老画布 `scene_editor.py`):**两块区域分开配**——
  「拉发射区域」(青色虚线,写 `area`)与「拉范围区域」(黄色实线 + 边带,写 `confine.area` 并打开限定),
  两个按钮互斥;画布上拖出一个框 = 那一块区域,之后拖顶点 / 双击边线加点 / 右键、Shift+点、Del 删点。
  「粒子限定在区域里」勾选框 + 边带宽 + 限高写 `confine`;边带只画在实际起限定作用的那块上。
  删范围区域 = 退回用发射区域(限定照开);两块都没了 `confine` 才一起删(没有区域的 confine 运行时整条忽略、
  校验器报 error)。**去掉「限定」勾 / 删掉最后一块区域时,confine(含拉好的范围区域)收进
  `_vfx_confine_stash`,本次会话里再勾上原样回来**——拉好的范围区域是手工活,一个勾选框点掉就没了不行
  (换场景清空;撤销照样可用)。
  数据的单一真相源是面板里 vfx 列表的行 dict,画布图元 `_VfxAreaPolygon`(按 `(实例 id, role)` 登记)是它的投影
  (同光环境曲线那套:面板发 `vfx_area_overlay_refresh_requested` → 单发定时器 → `set_vfx_area_overlay`)。
  🔴 **行 dict 存成 JSON 文本**(`_vfx_row` / `_set_vfx_row`),不存 dict:PySide 把 dict 转成 QVariantMap,
  **键被按字母重排**——场景页改一下 vfx 实例、盘上这一行的键序就全变(作者面文档里记过这个盲区,2026-09-13 修)。
  运行时语义见 [[vfx-system]]「粒子区域」。几条刻意的限制,改之前读 `_VfxAreaPolygon` 的 docstring:
  ① **图元没有 `entity_kind`**——叠放循环点选、选中集合、批量删除 / 复制 / 指派分组全按它认人;
  ② **框内不吃鼠标、不能整体拖**——跑马梁那圈几乎盖满整张图,框内可点 = 点哪都先点到它、
  在空白处一拖就把整个区域挪走;只认顶点与边线附近,边线附近但不在顶点上的按下放给下面;
  ③ **只有面板里选中的那条实例的区域能改**,点别的实例的边线 = 切到那条;
  ④ **提交与切行都排到下一拍**(图元 release 里改面板 = 画布手势安全卡点名的段错误);
  不在场景页时拖了区域,先 commit-on-leave 再装场景页、选中那条实例,再落数据(一次手势一条撤销)。
  同一场景重装(点空白 / 撤销 / 提交)时 `_load_vfx_widgets` 按 id 保住选中行——不保的话拖完一个顶点,
  选中跳回第一行,画布上"能改的区域"也跟着换人。护栏 `tools/editor/tests/test_scene_vfx_area.py`
  (真鼠标事件进视口;①②③、"先回场景页"、去勾收着范围区域、删范围区域退回发射区域各变异一次确认会红;
  键序比 JSON 文本不比 dict)。
- **保存前过同一道形状闸门**(`assets.normalize_effect`,与 `validator._validate_vfx_effects` 同口径):
  `id == 文件名`、`spawn.max ≥ 1`、`appearance.sizeWu > 0`、`onHit.emitter` 必须指向本效果内
  **别的**发射器、`subOnly` 不得带 behavior、发射器 id 不重复、`appearance.emissive ∈ [0,1]`
  (配 `lit:false` 会警告"没有意义",不拦)。键序按 `types.ts`:
  `id, label, emitters, authoring`。原子写。
- **删发射器前查引用**:还有 `onHit` 指着它就拒绝并说人话(自检 S12 钉住)。
- **只有真改了 doc 才标脏**;拖拽合成一条历史;**纯点一下 gizmo 不算编辑**;保存锁(保存在飞期间
  又改了就不清脏、状态栏说再按一次);磁盘操作一条链;装载门(换场景期间遮罩 + `#app` inert +
  序号守卫,期间拒存盘)——逐条照 [[trajectory-workbench]] 的硬契约。
- **检视器渲染只读**:缺省容器只在写入闭包里补,别在渲染时往 doc 里塞空容器。
- **下拉框一律走页内列表,不许用系统原生 `<select>` 弹窗**(`/vendor/dropdown.js`,`mousedown` 里
  `preventDefault()` 掐死原生弹窗,DOM 里的 `<select>` 原样留着所以读写与 `change` 全不变)。
  ⚠ 2026-09-12 制作人实拍:150% 缩放屏上 QtWebEngine 的原生弹窗**框按设备像素、内容按 CSS 像素**画,
  弹出来比控件大一圈、右下一大块白边,而且**每开一次再乘一次**,白边越开越大;它还不吃页面配色
  (页面暗色、弹窗系统色)。Qt 侧没有开关能关,只能不让它开。判据在自检 S17(开五次像素完全一致、
  列表宽度以控件为下限、选中发一次 `change`、Esc 不漏给页面键表)。
  另一条独立的坑:**Ctrl+滚轮会把整页缩放**(Ctrl 是 gizmo 吸附键,右栏又常滚),缩放一直累加、
  Qt 壳里没有 Ctrl+0 复位,只能关窗重开 —— 尚未修(桌面壳层面的事)。
- **自检的游戏地址钉在 `127.0.0.1:9`**,绝不会往真在跑的游戏里发临时效果;临时资产一律
  `zz_selftest_*` 前缀并在结束时删掉,**绝不在 `bat_cliff` 等真资产上保存**。

## 作者面怎么用(要点)

- **相机与 gizmo 一字不改照 Unity**(右键环视 + 按住右键 WASD/QE 飞、Alt+左键环绕、中键 / 空格+左键平移、
  滚轮朝光标缩放、`F` 对准选中、`Home` 整场、右上角坐标架切正交、`W/E/R` 三态 gizmo + `Ctrl` 吸附)。
  **选中任何东西、在任何视图、立刻出现 gizmo,轴心落在那个东西本身上、旁边写着选了什么**
  (这条被制作人打回过三轮,别再翻车)。
- 3D 里可选中并用 gizmo 操作的:发射器原点(`offset`)、群体的**巢半径 / 活动域半径 / 惊起半径**
  三个线框球(缩放 gizmo 改半径)、预览锚点(写 `authoring.anchor`,切 `surface` 落到对应面)、
  玩家标记(拖着走会自动带出 `player:motion` 场)、刺激点。
- 右栏按模块折叠:外观 / 发射 / 运动 / 寿命 / 碰撞 / 群体行为 / 薄片(纸钱)/ 声音;数值框带单位提示
  (wu / wu/s / wu/s²);`sizeOverLife` / `alphaOverLife` 有小折线编辑器;群体那块有一组
  「刺激权重」行——**标签不在 `attitude.fear` 表里 = 权重 0 = 完全没反应且不报错**,
  那组行就是为这条准备的。
- 控制条:播放 / 暂停 / 单步 / 重置 / 种子 / 倍速。**同种子 + 同 dt 串两次跑逐帧相同**(自检 S9)。
- **薄片(纸钱)**:风、铺撒区域、透视在本地预览里与游戏同口径(2026-09-12 接上,见上「喂给模拟的输入」;
  区域要本场景里有实例圈了 `area`,否则退成锚点周围圆盘、状态栏会写)。仍看不到的只有**片的朝向与弯曲**——
  3D 视图按点画,那部分去游戏里看,见 [[scene-wind]]。
- **它是桌面应用**:入口是桌面窗口(纯内存 profile、NoCache、服务端 `no-store`),单实例,
  第二次 `--open <id>` 把已开着的窗口切到那条资产;`--serve` 只是给自动化的裸服务。

## 联动(双槽,与声学同形)

| 路径 | 方向 | 内容 |
|---|---|---|
| `/__gamedraft-api/runtime-vfx` | 工作台 → 游戏 | `{rev, writer, effectId, def, sceneId?, probe?{seq, field, at}}`,`rev` 服务端自增 |
| `/__gamedraft-api/runtime-vfx-status` | 游戏 → 工作台 | 场景 / 引用该效果的实例状态与只数 / stats / 玩家脚点 / **spaceKind** / bootId;按页分桶 |

游戏侧 `src/dev/runtimeVfxSync.ts`,三个必须照抄的防死机制一个不少:每发挂超时、连不上指数
退避到 3 s、`statusLine()` 带收发计数(「以为在同步、其实早断了」是最贵的一种坏)。
套用走 `VfxSystem.applyPreviewEffect(effectId, def)`(用工作态定义覆盖缓存并重建引用它的实例);
`def = null` 撤销覆盖。**回传里的 `spaceKind` 要看**:planar 时游戏里那份预览的几何判据全是空的。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/vfx_workbench -q -p no:cacheprovider   # 36 条:资产读写 / 归一化 / 护栏 / 进程内真 HTTP / 打包(含依赖树扫描)
sh scripts/py.sh -m tools.vfx_workbench --selftest                       # 交互层 79 条,~8 s,有 FAIL 退出码 1
sh scripts/py.sh -m tools.vfx_workbench --check                          # 命令行跑一遍形状闸门(五份真资产)
```

`--selftest` 在无头桌面壳(offscreen + ANGLE/SwiftShader-WebGL)里装真页面,注入
`viewer/tests/selftest.js`:启动 / 坐标对齐 / 手性 / 相机手势(环视机位不动、环绕目标不动、
朝光标缩放光标下点不动、飞行键不漏给工具键表、正交仍能拾取)/ gizmo(单轴只动一个分量、
Ctrl 吸附是整数倍、纯点一下不入历史、选中单个东西立刻有 gizmo、2D 视图同一份 gizmo)/
巢与活动域三球缩放 / 锚点落地与落壳 / 玩家与刺激 / 群体真的对刺激起反应 / 本地预览确定性 /
保存往返与键序 / 保存锁 / 装载门 / 六条护栏拒绝 / 联动软失败 / **下拉框(S17)**:原生弹窗一个都不开、
开五次像素一致、选中与 Esc 的语义 / **薄片(S15,只读 paper_money @ 跑马梁)**:
风经运行时 `SceneWindState` 进模拟、按实例多边形铺撒、`metricAt` == 透视系数、有风比无风多动 3 倍以上、
无风时状态栏黄字警告(三处输入各拔掉一次,对应判据都红过)。
**改 viewer 下任何东西先跑它**;新抓到的坑往里加一条 `ok()`;改相机基要顺手变异一次确认判据会红。

## 相关

- 运行时:[[vfx-system]]
- 同模子的两台:[[trajectory-workbench]]、[[acoustic-workbench]]
- 坐标与手性:[[coordinate-spaces]]
