---
id: vfx-workbench
title: 粒子工作台(独立桌面应用 · 页内跑同一份运行时模拟 · 效果资产与布置库唯一写入者)
domain: editor-tools
type: mechanism
summary: 效果资产与布置库(场景 × 时段外观)唯一的作者面与唯一写入者;3D / 原画里摆发射器 / 巢与活动域 / 布置锚点 / 发射区域与范围区域 / 玩家 / 刺激,页内跑的是打包进来的运行时 vfxSim 本体(不是镜像);相机与 gizmo 经 /vendor 原样复用轨迹台那两份、不 fork;双槽实时推给游戏预览(整份工作态布置库 + 切时段);主编辑器只显示;桌面壳零缓存
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
  - src/dev/runtimeVfxSync.ts
  - tools/desktop_shell.py
triggers:
  paths: ["tools/vfx_workbench/**", "public/assets/data/vfx/**", "public/assets/data/vfx_placements.json", "src/dev/runtimeVfxSync.ts"]
  topics: [粒子工作台, vfx, 效果资产, 发射器, 群体, 巢, 刺激, 联动, gizmo, 布置, 时段外观, 发射区域, 范围区域]
  tasks: [做粒子效果, 改粒子工作台, 调群体参数, 摆巢, 加发射器, 布置粒子, 拉粒子区域, 调夜里的粒子]
verified_by:
  - tools/vfx_workbench/tests/test_assets_and_serve.py
  - tools/vfx_workbench/tests/test_bundle.py
  - tools/vfx_workbench/tests/test_placements.py
  - tools/vfx_workbench/tests/test_selftest.py
  - tools/vfx_workbench/viewer/tests/selftest.js
  - tools/editor/tests/test_scene_vfx_overlay.py
last_governed: 2026-09-14
---

## 是什么(一句话)

策划怎么做出一个粒子 / 群体效果并把它放进场景:开**粒子工作台**(`sh scripts/py.sh -m tools.vfx_workbench`,
主编辑器「工具 → 粒子工作台…」、开发控制台工具栏也有入口),选一个场景和一套**时段外观**装进来(按深度展开成 3D),
左栏加发射器、右栏按模块调参、3D 里拖发射器原点 / 巢与活动域 / 锚点 / 玩家 / 刺激点,
在「布置」一栏把效果布置到这个场景这套外观里、拉发射区域与范围区域,
**页面里当场跑起来看**,`Ctrl+S` 一次落两份:`public/assets/data/vfx/<id>.json` 与 `public/assets/data/vfx_placements.json`。
运行时那一半见 [[vfx-system]]。

**游戏只是预览器**(与声学台同一条):编辑与保存都在这里;游戏 F2「粒子」页只剩状态与刺激键。
**主编辑器也只是显示器**(制作人 2026-09-13 定):场景画布只读地画出发射区域 / 范围区域 / 锚点,
场景页 vfx 块只有「显示时段外观」下拉、摘要和「刷新粒子数据」——效果和布置一个字都不在那边改。
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
`depthShellField` / `groundHeightfield` / `sceneWind` / `perspectiveScale` / `vfxRandom`(布置没写种子时的
`hashSeed(id)`)/ `vfxConfine`(范围区域边带内沿 `confineDistanceContour`))打成 ESM
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
| 锚点 / 种子 / 数量 / 粒子区域 | 布置 `anchor` / `seed`(没写 = `hashSeed(id)`)/ `countScale` / `area` + `confine` → `VfxInstanceSim` | **活动布置**(本场景本时段外观里选中的那条;没选则取当前效果的第一条)的这几样原样喂,种子也走 bundle 里的 `hashSeed`,**`confine` 一起带上**(2026-09-13 补:只带 `area` 时工作台里纸钱照样飞出框,和游戏不一样);没有活动布置 = `authoring.anchor`、无区域,状态栏写"本场景本时段没有布置这个效果" |
| 透视度量 | `perspectiveScaleResolver.scaleAt` → `createFieldVfxSpace({perspective})` | 同一个 `createPerspectiveScaleResolver(scene.perspectiveScale)` |

⚠ 2026-09-12 实测:三样都没接时,纸钱(薄片只吃场景风)520 张在工作台里 **0 张动**、铺在出生点周围而不是
实例圈的山顶、尺寸不按透视折——制作人原话"本地预览根本没效果"。接上后跑马梁 6 s 内 123 张被吹动、
阵风顶上 13 张离地(与游戏实测同量级);**无风时仍有 ~27 张**在坡上自己滑,那是重力,不是 bug。
状态栏:`风 N wu/s` / `无风`、`薄片 离地 / 醒`、`布置「…」种子 …`、`限定区域`;有薄片而本场景没有 wind 时整行变黄警告。

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

- **本工作台是 `assets/data/vfx/` 与 `assets/data/vfx_placements.json` 唯一的写入者。** 主编辑器只读它们
  (场景画布显示区域 / 实例候选 / 校验),没有脏桶、不进 save_all、不进外部改动基线。两个写入者的下场是互删。
  ⚠ 2026-09-14 之前布置在场景 JSON `vfx[]` 里、由主编辑器场景页编辑(拉区域、改表单),制作人原话
  "主编辑器里只负责显示,画蛇添足";那一整套已拆掉,场景页只剩显示。场景 JSON 残留 `vfx` = 校验器 error。
- **布置按「场景 × 时段外观」分份,没配就没有**(形状与运行时判据见 [[vfx-system]]「布置取哪一份」):
  顶栏「时段外观」选择取代原来的背景选择——选项 = 基底(文字写出它覆盖哪几个时段)+ 场景 `timeVariants` 的键,
  切换 = 装那套外观的背景(3D 贴图与 2D 原画都换,几何共用)并显示那一份的布置。**换场景 / 换时段外观不丢布置改动**
  (库是全局的工作态),只丢在飞手势。形状 / 键序 / 查询一律用共享模块 `tools/editor/shared/vfx_placements.py`
  (与主编辑器、校验器同一份),本台的 `placements.py` 只加写盘、语义检查、改名删除连带三件事。
- **撤销 / 重做 / 脏态 / 保存锁同时覆盖效果 doc 与布置库**(History 的快照是两者的复合)。`Ctrl+S` 一次存两份,
  走同一条 `runIO` 链;**只成功一半时状态栏如实说哪份没存上、不清脏**。换效果时历史照旧清空,未存的布置改动留着
  但不再能撤销。
- **日常流程的保存纪律**(2026-09-14 审查,自检 S10 / S19 钉住):
  ① `Ctrl+S` **先让焦点所在的输入框失焦**(`commitFocusedInput`)——检视器数值框只在 `change` 时写回,光标还在框里就存,
  存的是改之前的值、状态栏还说"已存";② **只存真改了的那份**,什么都没改 = 不发请求、状态栏说"没有未保存的改动"
  (原样重写会替别处的改动做撤销);③ **存盘不清撤销栈**:存完才发现删错了布置,`Ctrl+Z` 还回得去;
  ④ 保存按钮自己显示脏态(橙色「保存 ●」+ 窗口标题带 ●),原来只有底栏一行小字。
- **关窗 / 刷新保护**:页面挂 `window.__unsavedSummary()` / `__saveUnsaved()`,桌面壳关窗与 F5 时来问、弹「保存并关闭 /
  不保存 / 取消」(机制见 [[trajectory-workbench]]「它是桌面应用」)。⚠ 光写 `beforeunload` 没用:关 QMainWindow 根本不跑它。
- **打开效果装哪个场景**(`syncEnvWithDoc`):开页 / `--open` / 主编辑器打过来 = 去它**第一条布置**的那份并选中
  (原来停在第一个有深度的场景,作者第一眼只看到"本场景本时段没有布置这个效果");**已经在某个场景里、从下拉框换效果 = 不跳**,
  状态栏说它布置在哪——作者多半正要把它布置到这里,而新建的效果一律带作者场景,照它跳等于每次换效果都被拽走。
- **新建 / 复制先问再动盘**:当前效果有未保存改动时先选「先保存 / 不保存 / 取消」(复制多一个「改动带进副本」=
  `/api/duplicate` 带 `doc`,源文件不动)。原来先写盘再问"丢弃?",选取消就留下一个没人要的文件。
- **检视器改完按 Tab 能走到下一格**:输入框 `change` 引起的重建推到下一拍、建完把焦点放回同位置的控件并保住右栏滚动。
  ⚠ Chromium 派发这个 `change` 时 `activeElement` 已经是 body,只看焦点判不出来——按事件来源(捕获期标记)判。
  下拉框 / 勾选框在选中那一刻提交,照常同步重建(自检 S16 同步读 DOM)。
- **键盘**:勾选框 `change` 之后焦点还回页面(否则空格变成再勾一次);**鼠标在页内下拉列表里选完也还焦点**
  (`Dropdown.pick` 发的是合成 `change`,`isTrusted=false`;不还的话检视器重建把焦点放回下拉框,接着按方向键想微移,改的是下拉框的值);
  **输入框里按 Enter = 提交并离开这一格**(检视器与预览条都算,对话框里的 Enter 仍是确定;
  焦点留在框里的话 `Ctrl+Z` / 空格 / `W/E/R` 全被吃掉,重建后框里文字还被选中、按 Delete 就清了);
  **收起的下拉框上**:方向键 / Tab / Enter / Delete 归下拉框(方向键逐项切换——⚠ 别在 `change` 里给下拉框失焦,
  逐项切换每步都发 `change`,第一步失焦后第二下方向键落到页面上变成「微移」选中物),其余快捷键放掉它的焦点并照常执行
  (不做首字母跳转:按 F 想对准,原来换成了 fireflies);空格**松开时**才切播放、按住的自动重复与空格 + 拖(平移)都不切;
  选中一条布置按 `Delete` = 删这条(可撤销;删完库里任何场景 / 时段都没有这个 id、而剧情数据里有 `playVfx` / `stopVfx` / `setVfxState` / 条件引用它时,先列出引用要确认);对话框 `Esc` = 取消,对话框里的下拉列表开着时 `Esc` 只关列表。
- **换效果**:有未保存改动时「先保存 / 不保存 / 取消」(与新建 / 复制同一个 `resolveDirtyBefore`);**撤销栈不清**——
  每条复合快照的 doc 换成新打开的这份(`rebaseHistoryOnDoc`),只改了旧效果 doc 的条目丢掉,库的改动照样能撤销。
  ⚠ 不看 `libDirty`:第一版"库脏才保留",「先保存」/ Ctrl+S 顺带把库存了、库一干净换效果就整个清空(第二轮复核抓到)。
  只有**改名 / 删效果**传 `resetHistory` 清栈:服务端改了盘上的库、页面整份换过 `S.lib`,旧快照里是旧 id / 删掉的布置。
- **关窗保护先提交输入框**:`__unsavedSummary()` 开头 `commitFocusedInput()`——点标题栏 X / 按 F5 都不会让页面里的输入框失焦,
  刚打的数没按 Enter 就不算脏,壳直接关了。
- **保存布置库的语义检查只否决本次真改了的那几份**(norms 不变量 9:否决面只罩将写盘的脏域):场景不存在 /
  时段键不是该场景的外观键 → 改过的那份拒存,盘上原样没动的那份只 warning(场景被删了不能把整个库锁死);
  效果不存在一律 warning。**盘上的库读不懂时拒绝覆盖**。
- **效果改名连带布置、删除先问布置**:改名要求效果与库都已保存,先写库再改名文件,改名失败回滚库;
  删除时列出全库引用它的布置(场景 · 时段外观 · id),作者选「连布置一起删」才动,先写库再删文件。
- **布置的锚点就是锚点**:有活动布置时「锚点」选中 / A 工具 / 2D 拖动 / gizmo 改的是**布置的 `anchor`**,
  没有时才改效果自己的 `authoring.anchor`(预览工作态,运行时忽略)。挂点模式(`authoring.attach`)不变。
- **粒子区域在本台两个视图里都能编**(2026-09-14 从主编辑器搬来,语义逐条不变):
  「拉发射区域」(青色虚线,写 `area`)/「拉范围区域」(黄色实线 + 边带,写 `confine.area` 并打开限定)——
  按住拖一个框 = 那块区域(3D 里框角取地面拾取点再 `worldToScene`);活动布置的每个顶点是可选对象
  (`area:emit:<i>` / `area:range:<i>`),**一选中立刻出 move gizmo**,拖 = 顶点沿地面走;双击边线插点;
  Delete / 右键删点(剩 3 个再删 = 删整块,先确认)。3D 里贴地折线,2D 多边形;范围区域的边带内沿用运行时
  `confineDistanceContour`(不在 JS 里另写)。检视器「布置」一节:id、effect(只读)、锚点、种子(空 = 按 id 哈希)、
  数量倍率、自动开、「粒子限定在区域里」+ 边带宽 + 限高、清除两块区域;conditions 只读显示条数、原样保留。
  删范围区域 = 退回用发射区域(限定照开);两块都没了 `confine` 一起删;**去掉「限定」勾时 confine(含拉好的范围区域)
  收进本次会话的 stash,再勾上原样回来**——拉好的范围区域是手工活,一个勾选框点掉就没了不行。
- **左栏两块**:「布置 · 场景 · 时段外观」列这一份全部实例(别的效果的行灰显、带「打开这个效果」;按钮:
  把当前效果布置到这里 / 删 / 上下移 / 改 id(状态栏提醒 playVfx 与条件按 id 引用;库里再没有这个 id 时列出引用它的具体文件)/ 复制到时段…(目标有同 id
  时选覆盖或跳过));「这个效果还布置在」列全库引用当前效果的布置,点一下切到那个场景那个时段并选中——
  一个效果可以布置到多个场景,不绑场景。
- **主编辑器那一侧**:「工具 → 粒子工作台…」起进程、「工具 → 刷新粒子数据」手动重读(效果 + 布置库一起,
  只 emit 一次);工作台进程退出、或主窗重新获得焦点时静默 `reload_vfx_from_disk()`(盘上没变就什么都不做)。
  场景页 vfx 块:「显示时段外观」下拉(默认跟画布的时段视图)+ 只读摘要 + 「刷新粒子数据」,**没有任何编辑控件**;
  有布置才展开、标题带条数(`世界空间效果 vfx（粒子）· N 个布置`——默认折叠不带条数,作者的结论会是
  "这编辑器根本没有粒子配置",2026-09-11 制作人原话)。画布图元 `_VfxAreaPolygon` / `_VfxAnchorMarker`
  **不吃任何鼠标键、形状为空、没有 `entity_kind`**,压在实体上面也点得穿;护栏 `tools/editor/tests/test_scene_vfx_overlay.py`
  (真鼠标事件:在区域顶点 / 边线上拖,库与选中集合都不变、边线下的 NPC 照样点得中;16 处变异各红过)。
- **保存前过同一道形状闸门**(`assets.normalize_effect`,与 `validator._validate_vfx_effects` 同口径):
  `id == 文件名`、`spawn.max ≥ 1`、`appearance.sizeWu > 0`、`onHit.emitter` 必须指向本效果内
  **别的**发射器、`subOnly` 不得带 behavior、发射器 id 不重复、`appearance.emissive ∈ [0,1]`、
  `appearance.lightGain ∈ [0,10]`(两者配 `lit:false` 都会警告"没有意义",不拦)。键序按 `types.ts`:
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
  Qt 壳里没有 Ctrl+0 复位,只能关窗重开 —— 2026-09-14 修:页面在 window 上对 `ctrlKey` 的 wheel `preventDefault`
  (只拦浏览器的页面缩放,3D / 2D 视图自己的滚轮照常收到),桌面壳加 `Ctrl+0` 复位兜底。草木台同样处理。
- **自检的游戏地址钉在 `127.0.0.1:9`**,绝不会往真在跑的游戏里发临时效果;临时资产一律
  `zz_selftest_*` 前缀并在结束时删掉,**绝不在 `bat_cliff` 等真资产上保存**。

## 2026-09-14 第三轮复核(完整日常流程)修掉的

- **游戏侧预览覆盖**:撤掉一个效果的预览覆盖(换了效果 / 关工作台)时**绕过 JSON 缓存从盘上重读**(`AssetManager.dropJson`)——
  原来存盘后换效果,游戏退回开局时缓存的旧版,整局都是旧的;**定义没变就不重建实例**(`previewEffectJson`)——
  原来拖一个区域顶点、切时段外观、三分钟保活都会让同效果的所有群重飞、纸钱重撒。
- **关窗选「不保存」**:`__onDiscardUnsaved` 把盘上的效果与布置库推给游戏,游戏不再挂着丢掉的工作态(原来要刷新游戏页才会消失,5 分钟内刷新还会被重新套上)。
- **「让游戏切到这个时段」**:游戏页没开时先记着、游戏起来再发(原来发了也被当成"第一眼看到的旧请求"吞掉);
  游戏已经是这套外观就不发、按钮置灰;游戏侧再兜一道(当前外观 = 目标外观就不推进时间——原来能让游戏过一整天、跑一次日终)。
- **效果形状暂时不对时布置照推**:用上一份合法定义 / 盘上那份推,回 `defErr` 在状态标签上黄字说;刺激反应 × 删空的表一并删掉。
- **删除 / 改名效果查外部引用**:挂件预设 `prop_presets.json`(`vfx` 与 `states[*].vfx`)与数据里的 `playVfx`;删除要单独确认、
  改名直接拒绝并说去主编辑器改哪个文件;「这个效果还布置在」不再对被挂件用着的效果说"游戏里不会出现"。工作台不写那些文件。
- **动画状态名是下拉**(`/api/anims` 返回 `[{path, states}]`),打错的状态名形状闸门警告(运行时会静默退回第一个状态)。
- **拖拽**:直接拖锚点 / 发射器 / 刺激点与拖 gizmo 中心一样是**相对位移**(保 h、表面、y 偏移;原来拖一下就贴到背后的地面、高度清零、
  每个鼠标移动重建模拟);`Alt` 才是"落到光标下的表面"。偏移为 0 的发射器与锚点叠在一起时**先拾取锚点**
  (原来拖到的是发射器、改的是所有布置共用的 `offset`)。选中半径时缩放 gizmo 中心优先;拖线框球改半径;隐藏群体半径图层后球不再能点中。
- **曲线编辑器**:拖动期间刻度固定、按引用追踪被拖的键(原来值越拖越塌、越过邻居会覆盖邻居、永远超不过当前最大值)。
- **按下鼠标期间不重建左栏 / 检视器**(`pressedIn` → 松开再补):原来输入框里改了数直接去点左栏一行,那一下点击被吞。
- **记住当前发射器**(`S.emitterId`,左栏次级高亮):选锚点 / 顶点 / 刺激点时检视器与发射器按钮不再跳回第一个发射器。
- **键盘与手势**:单键快捷键忽略自动重复(松开右键飞行时还按着 A 不会切到锚点工具);`Esc` 取消正在拉的区域框、任何放置工具(A / M / K / 区域 / H)回到选择;
  删前面的顶点时后面选中的顶点号跟着减一;右键 + WASD 飞行算"动过",松开不删光标下的顶点;
  未改动的检视器输入框里 Ctrl+Z / Ctrl+Y 走页面撤销;方向键微移玩家 / 刺激点不重建模拟;布置 ↑↓ 后选中的还是那一行。
- **切场景**清掉刺激点、场与玩家标记(挂点模式重新放在锚点脚下);**2D 视图第一次切过去是整幅**(隐藏时的 fit 推到显示后)。
- 桌面壳把页面 `document.title` 同步到窗口标题栏(原来「●」只在页内)。

## 2026-09-14 第四轮复核修掉的

- **「让游戏切到这个时段」时游戏在别的场景**:不报成功、先记着 `pendingPhase` 并把游戏拉到本场景(`/api/link/launch`),
  游戏进了这个场景再核一次是否已经是这套外观、需要才发;60 s 还没进来就作废。原来游戏侧拿**它当前那个场景**比外观,判成"已经是了",什么都不做还报"已让游戏切到"。
- **检视器按稳定的 `data-key` 还焦点**(`Inspector.stampKeys`:区块 / 行名 / 序号),键不在了就不还——原来按位置还,
  改了一个会增删行的数(湍流强度)再点下面的格子,接着打的数落进了新冒出来的那一格。
- **下拉列表开着时不重建检视器**:`dropdown.js`(共用件,附加改动)`close()` 发 `ddclose`、对已脱离文档的下拉 `pick()` 发 `ddstale`;
  页面在 `ddclose` 后补重建,`ddstale` 时提示再点开选一次。原来改了布置 id 没按回车直接去点「自动开」,选了等于没选。
- **画布跟着中间区域尺寸走**(`ResizeObserver`):顶栏换行 / 状态标签多一行时画布缓冲区没重设,2D 点不中、3D gizmo 画偏。
- **玩家标记的速度是真速度**:M 工具点一下 = 静止,拖动按距离 / 真实时间算,不动 100 ms 归零,开始播放归零——原来暂停时一放玩家就是冲刺,一按播放群就惊飞。
- **存盘不重开本地预览**:服务端只重排键序,内容(与键序无关的 `canonJson`)没变就不 `rebuildSim`。
- **方向键微移合成一次手势**:第一次按下开拖拽、松开最后一个方向键 / 按别的键 / 点鼠标 / 400 ms 不按收尾——一条撤销、一次重建、一次推送;
  真的微移了才 `preventDefault`(原来按住一秒三十条撤销、预览重开三十次、侧栏还跟着滚)。
- **改布置 id / 撤销改名**:`S.placeId` 与限定暂存键在改名之前挪好;撤销 / 重做按"这个效果在这一份里的第几条"跟住同一条布置,找不到就清选中——
  原来预览跑去了同效果的另一条布置,撤销后按 Delete 删的也是另一条。
- **预览锚点只在它的作者场景里用**:`authoring.anchor` 属于别的场景时退回出生点;在别的场景里新建预览锚点时顺带记下作者场景。
- **曲线编辑器**:空曲线画出隐含的默认线(1);第一次点击先铺 `[[0,1],[1,1]]` 再加点(原来一下点出只有一个键的平线,整条寿命透明 / 尺寸为 0);右键删最后一个键 = 去掉这条曲线。
- 滚轮在聚焦的数字框上先让它失焦(面板照常滚,数值不被滚改);`openEffect` 开头先提交焦点输入框;删前面的刺激点时后面选中的序号跟着减;
  场景信息标签不再挡画布的点击与滚轮。

## 2026-09-14 第五轮复核修掉的

- **删布置查剧情引用**:`placements.external_refs_to_instance(id)`(与效果引用扫同一批文件)收 `playVfx` / `stopVfx` / `setVfxState` 的 `instanceId`
  与条件叶子 `vfx == id`,`GET /api/instance_refs?id=` 回 `{ok, refs:[{file, path, kind}]}`;`delPlacement` 删完库里再没有这个 id 时去查,
  有引用就在页内对话框里列出(最多 8 条)要「仍然删除」,接口不在 / 出错照旧删。等待期间场景 / 时段 / 效果变了或那一行没了就作废。
  主编辑器校验器对这三个动作同样警告"库里没布置这个实例"(原来只有条件叶子有)。
- **关了「联动」再放弃**:`discardLiveWorkingCopy` 看这次会话推成功过(`S.link.lastPub`)就把盘上那份推回去,不再只看勾选框。
- **「记为作者场景」**(`bindAuthoringScene`):预览锚点属于别的场景时先按本场景出生点重铺再改 `sceneId`;
  原来别的场景的坐标被当成本场景的,紧接着「把当前效果布置到这里」就把布置放到了那个坐标。检视器与左栏同一条判据
  (`host.authoringAnchorHere`):锚点在别的场景时不显示那边的画面点 / 离面高 / 落在,只说"预览锚点记在「X」,这里用出生点"。
- **从左栏选中东西 = 回到选择工具**(先取消正在拉的区域框):原来 A / M / K 还挂着,选中的东西没 gizmo,下一下点击是放锚点 / 瞬移玩家 / 往游戏里发刺激。
- **脏态与键序无关**:`docKey` / `libKey` 用 `canonJson`——保存后服务端重排了键,撤销再重做就亮「保存 ●」、关窗还问。
- **撤销 / 重做后区域顶点选中跟住**:点数没变保序号(撤销拖动),点数变了按坐标找,找不到清选中。
- **键盘逐项换效果 / 场景 / 时段**:忙碌遮罩把 `#app` 设 inert 会把焦点踢到 body,第二下方向键变成微移;键盘触发的切换装完后把焦点还给那个下拉框。
- **下拉框上按 Enter 不弹系统原生列表**(共用 `dropdown.js`):收起时 Enter / F4 / Alt+↑↓ 打开页内列表(↑↓ / Home / End 移高亮、跳过禁用项,Enter 选);
  空格只 `preventDefault` 不拦传播(页面空格播放照常);Esc 在 window 捕获阶段只关列表。
- **预览条状态文字单行省略**(全文在 `title`,⚠ 警告放最前面):原来播放时字数变化让预览条换行 / 收回,画布上下跳。
- **2D 视图也认「场景」图层勾选**。

## 2026-09-14 第六轮复核修掉的

- **点击选最近的标记**(`view3d.js` 的 `pickObjectAt`,2D / 3D 共用):所有点状标记同一个拾取半径 12 px(`PICK_R`),
  取屏幕距离最近的;与最近者差 1.5 px 以内(`PICK_TIE`)算并列,并列时当前选中优先、再按 `objects()` 次序(锚点仍先于零偏移发射器),
  **保持选中只在它属于并列最近时生效**。原来是"范围内第一个":纸钱区域离锚点 30 wu 的顶点在默认缩放下点不中,点到的是锚点,
  按 Delete 删掉的是整条布置;窗口小一点点到的是发射器(拾取半径还比锚点大 1 px),一拖改的是所有布置共用的 `offset`。
- **发射方向有"不写"这一档**(`Inspector.directionRows`):方向是下拉 `各向同性(不写)` / `沿命中法线(不写)`(subOnly)/
  `各向同性;被撞击触发时沿命中法线(不写)`(被别的发射器 onHit 指着)/ `指定方向`,选指定才出三格向量(一次编辑写 `[0,1,0]`),
  选不写一次编辑删掉 `spawn.direction`(`spread` 留着,运行时不看)。没方向又不是 subOnly / 撞击目标时锥角置灰、行上 title 说明。
  原来没写方向时显示 0 / 1 / 0(读起来是"朝上",实际各向同性),锥角填了没用,改一格 X 就把萤火虫变成一条光柱且回不去。
- **A 工具说清改的是什么**:有活动布置时撤销标签 `挪布置锚点 · <id>`、按钮提示说"改的是这条布置的 anchor(游戏用、会推给游戏、存进布置库)";
  没有才是 `放预览锚点` / `authoring.anchor`。

## 2026-09-14 第七轮复核(收敛)修掉的

- **拉完区域不再选着布置锚点**(`commitAreaDraft`):「把当前效果布置到这里」和打开有布置的效果都会选中 `anchor`,点区域工具不动选择;
  原来拉完框锚点 gizmo 又回来,框拉歪了按 Delete 想删框,删掉的是整条布置(锚点 / 种子 / 两块区域一起没)。
  现在写入成功后选中的是 `anchor` 或区域顶点就 `select('')`;状态行改成「选中顶点后 Delete / 右键删点」。自检 S18。
- 本台下拉框点别处关列表那一下整个被吃掉(共用的 `dropdown.js`,见 [[trajectory-workbench]] 下拉框一节)。

## 作者面怎么用(要点)

- **相机与 gizmo 一字不改照 Unity**(右键环视 + 按住右键 WASD/QE 飞、Alt+左键环绕、中键 / 空格+左键平移、
  滚轮朝光标缩放、`F` 对准选中、`Home` 整场、右上角坐标架切正交、`W/E/R` 三态 gizmo + `Ctrl` 吸附)。
  **选中任何东西、在任何视图、立刻出现 gizmo,轴心落在那个东西本身上、旁边写着选了什么**
  (这条被制作人打回过三轮,别再翻车)。
- 3D 里可选中并用 gizmo 操作的:发射器原点(`offset`)、群体的**巢半径 / 活动域半径 / 惊起半径**
  三个线框球(缩放 gizmo 改半径)、锚点(有活动布置写布置的 `anchor`,否则写 `authoring.anchor`;切 `surface` 落到对应面)、
  活动布置的区域顶点、玩家标记(拖着走会自动带出 `player:motion` 场)、刺激点。
- 右栏按模块折叠:外观 / 发射 / 运动 / 寿命 / 碰撞 / 群体行为 / 薄片(纸钱)/ 声音;数值框带单位提示
  (wu / wu/s / wu/s²);外观里「镜面/自发光」「受光强度」两行只在受光(`lit` 没关)时出现——
  「受光强度」= `appearance.lightGain`(乘在该发射器收到的光上、不乘自发光,见 [[vfx-system]]),
  空 = 删键(缺省 1)、夹 0..10、一次改动一条历史(自检 S23 #3);`sizeOverLife` / `alphaOverLife` 有小折线编辑器;群体那块有一组
  「刺激权重」行——**标签不在 `attitude.fear` 表里 = 权重 0 = 完全没反应且不报错**,
  那组行就是为这条准备的。
- 控制条:播放 / 暂停 / 单步 / 重置 / 种子 / 倍速。**同种子 + 同 dt 串两次跑逐帧相同**(自检 S9)。
- **调夜里的粒子**:顶栏时段外观切到「夜」→ 布置那一份 → 「让游戏切到这个时段」(游戏走正常时段推进换装)。
  游戏面板显示 `时段 … · 外观 …`,同场景但游戏外观 ≠ 工作台时段外观时整行黄字("你在调夜,游戏现在是白天")。
  基底没有可切的真实时段(没开日夜 / 每个时段都单列了外观)时按钮置灰。
- **薄片(纸钱)**:风、铺撒区域、透视在本地预览里与游戏同口径(2026-09-12 接上,见上「喂给模拟的输入」;
  区域取活动布置的 `area`,没有布置或没圈区域就退成锚点周围圆盘、状态栏会写)。仍看不到的只有**片的朝向与弯曲**——
  3D 视图按点画,那部分去游戏里看,见 [[scene-wind]]。
- **它是桌面应用**:入口是桌面窗口(纯内存 profile、NoCache、服务端 `no-store`),单实例,
  第二次 `--open <id>` 把已开着的窗口切到那条资产;`--serve` 只是给自动化的裸服务。

## 联动(双槽,与声学同形)

| 路径 | 方向 | 内容 |
|---|---|---|
| `/__gamedraft-api/runtime-vfx` | 工作台 → 游戏 | `{rev, writer, effectId, def, sceneId?, probe?{seq, field, at}, placements?{library, sceneId, phase}, phaseRequest?{seq, timePhase}}`,`rev` 服务端自增 |
| `/__gamedraft-api/runtime-vfx-status` | 游戏 → 工作台 | 场景 / **timePhase / appearancePhase / placementsApplied{sceneId, phase, preview}** / 引用该效果的实例状态与只数 / stats / 玩家脚点 / **spaceKind** / phaseSeqDone / bootId;按页分桶 |

游戏侧 `src/dev/runtimeVfxSync.ts`,三个必须照抄的防死机制一个不少:每发挂超时、连不上指数
退避到 3 s、`statusLine()` 带收发计数(「以为在同步、其实早断了」是最贵的一种坏)。
套用走 `VfxSystem.applyPreviewEffect(effectId, def)`(用工作态定义覆盖缓存并重建引用它的实例);
`def = null` 撤销覆盖。**回传里的 `spaceKind` 要看**:planar 时游戏里那份预览的几何判据全是空的。
- **`placements.library` 是整份工作态布置库**(含未保存改动),游戏 `applyPreviewPlacementLibrary` 整份顶替、当前那份按 id 差分。
  只推"当前展开的那一份"不行:作者切到另一时段,游戏就退回会话里缓存的旧库(哪怕刚存过盘)。
  服务端透传前过 `normalize_library`,过不了就不推布置、回 `placementsErr`,效果照推。
- **送到了才算推过**:`lastPub`(保活计时)只在 `ok` 时更新;游戏页刚起来 / 刷新(状态回传的 `bootId` 变了)**立刻补推**工作态——
  原来失败也记 `lastPub`,先调参再「拉起游戏」要等三分钟保活,这段时间游戏里是盘上那份。连不上 dev server 是常态,
  状态标签写中性的"游戏没开(开了会自动推过去)",不再挂红字"游戏没收到:目标计算机积极拒绝";换效果 / 换场景也推一次。
- **`phaseRequest` / `probe` 的序号是"粘住"的**:之后每次发布都带着同一个序号重发——否则 400 ms 内再改一下,
  槽被新文档覆盖,游戏还没读到那次请求就丢了;同序号重发不会重复执行(游戏只认比记住的大的)。
- ⚠ **vite 槽插件会剥掉不认识的字段**:新加的字段必须在 `vite.config.ts` 的 `runtimeVfxApi` 里显式透传
  (2026-09-14 当场发现:不补的话布置与切时段请求一个也到不了游戏,两边都不报错)。现在形状不对回 400,
  `game_link` 把 400 的正文当 err 回给页面。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/vfx_workbench -q -p no:cacheprovider   # 71 条:资产 / 布置库读写 / 语义否决 / 改名删除连带 / 复制带工作态 / 进程内真 HTTP / 打包 / 自检不写真库
sh scripts/py.sh -m tools.vfx_workbench --selftest                       # 交互层 240 条,~15 s,有 FAIL 退出码 1;布置库落临时目录
sh scripts/py.sh -m tools.vfx_workbench --check                          # 命令行跑一遍形状闸门(全部效果资产 + 布置库)
```

`--selftest` 在无头桌面壳(offscreen + ANGLE/SwiftShader-WebGL)里装真页面,注入
`viewer/tests/selftest.js`:启动 / 坐标对齐 / 手性 / 相机手势(环视机位不动、环绕目标不动、
朝光标缩放光标下点不动、飞行键不漏给工具键表、正交仍能拾取)/ gizmo(单轴只动一个分量、
Ctrl 吸附是整数倍、纯点一下不入历史、选中单个东西立刻有 gizmo、2D 视图同一份 gizmo)/
巢与活动域三球缩放 / 锚点落地与落壳 / 玩家与刺激 / 群体真的对刺激起反应 / 本地预览确定性 /
保存往返与键序 / 保存锁 / 装载门 / 六条护栏拒绝 / 联动软失败 / **下拉框(S17)**:原生弹窗一个都不开、
开五次像素一致、选中与 Esc 的语义 / **薄片(S15,只读 paper_money @ 跑马梁)**:
风经运行时 `SceneWindState` 进模拟、按实例多边形铺撒、`metricAt` == 透视系数、有风比无风多动 3 倍以上、
无风时状态栏黄字警告(三处输入各拔掉一次,对应判据都红过)/ **布置(S18,43 条,只写临时库)**:
时段外观切换装那套背景、布置到这里 → 存 → 盘上键序、2D 与 3D 各拉一次区域、选中顶点两个视图立刻有 gizmo、
gizmo 只动那一个顶点、双击插点 / Delete 与右键删点、撤销覆盖布置、预览 sim 收到活动布置的 area + confine、
publish 体带 placements 与 phaseRequest、只存成一半不清脏、限定勾 stash、复制到时段的覆盖 / 跳过
(页面 29 处 + 服务端 14 处变异各红过)。
**改 viewer 下任何东西先跑它**;新抓到的坑往里加一条 `ok()`;改相机基要顺手变异一次确认判据会红。

## 相关

- 运行时:[[vfx-system]]
- 同模子的两台:[[trajectory-workbench]]、[[acoustic-workbench]]
- 坐标与手性:[[coordinate-spaces]]
