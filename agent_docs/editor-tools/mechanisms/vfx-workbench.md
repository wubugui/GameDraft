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
last_governed: 2026-09-11
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
| `viewer/common.js`(SceneCal、**左手 lookAt**、射线与投影)、`gizmo.js`(GZ / Gizmo 全套)、`history.js` | 经 `serve.VENDOR` 白名单路由 **`/vendor/*` 原样直供页面**——不拷贝、不 fork。声学台内联 fork 过一份 GZ,那是已知欠账,这里没有加第三份 |
| `trajectory_workbench.geometry`(SceneGeometry / list_scenes)与 `serve.get_geometry / scaled_background` | Python 侧直接 import,几何路由与轨迹台同一套、共用同一份 LRU 缓存 |
| `acoustic_workbench.game_link` 的地址发现 / 拉起 / 切场景 | 直接 import,不做第三份 |
| `tools/desktop_shell.py` / `atomic_io.py` / `dev.game_preview` | 原样 |
| vite 的 `pickAcousticsStatusPage`(状态槽按页分桶) | 直接借用,规则逐字相同 |

⚠ 两个已踩的复用坑:`list_scenes()` 的字段叫 **`depth`** 不是 `hasDepth`(照声学台写会把所有场景
静默标成"无深度");轨迹台的 `SceneCal` **没有** `viewDirWorld`(那是声学台 `mathx.js` 才有的),
视线方向一律走运行时 `sceneSpace.viewDirWorld`。

## 本地预览 = **运行时模拟本体**,不是镜像

`bundle.py` 用仓库自带 rolldown 把 `vfxSim.ts` + `vfxSpace.ts` + `vfxNoise.ts` + `vfxRandom.ts` +
`sceneSpace.ts` + `depthShellField.ts` + `groundHeightfield.ts` + `worldReconstruct.ts` +
`groundDepthField.ts` 打成 ESM(`/gen/vfx.bundle.js`,落 `viewer/_gen/`,不入库)。
页面装完场景后用 `/api/scene_ground` + `/api/scene_shell` 在 JS 里建 `SceneSpaceGeometry` 与
`DepthShellField`,`createFieldVfxSpace`,然后 `new VfxInstanceSim(...)` **真跑**。
**别在 JS 里另写一份模拟**:两份必然漂,而且漂了一处都不报错。

⚠ **打包必须在子进程里做**:`tools/testing/repo_write_guard.py` 装在 pytest 进程里,而 bundle 要往
工作树内的 `viewer/_gen/` 写 —— 测试里直接 `ensure_bundle(force=True)` 必被 `RepositoryWriteBlocked` 拦。

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
- 右栏按模块折叠:外观 / 发射 / 运动 / 寿命 / 碰撞 / 群体行为 / 声音;数值框带单位提示
  (wu / wu/s / wu/s²);`sizeOverLife` / `alphaOverLife` 有小折线编辑器;群体那块有一组
  「刺激权重」行——**标签不在 `attitude.fear` 表里 = 权重 0 = 完全没反应且不报错**,
  那组行就是为这条准备的。
- 控制条:播放 / 暂停 / 单步 / 重置 / 种子 / 倍速。**同种子 + 同 dt 串两次跑逐帧相同**(自检 S9)。
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
sh scripts/py.sh -m pytest tools/vfx_workbench -q -p no:cacheprovider   # 34 条:资产读写 / 归一化 / 护栏 / 进程内真 HTTP / 打包
sh scripts/py.sh -m tools.vfx_workbench --selftest                       # 交互层 71 条,~7 s,有 FAIL 退出码 1
sh scripts/py.sh -m tools.vfx_workbench --check                          # 命令行跑一遍形状闸门(五份真资产)
```

`--selftest` 在无头桌面壳(offscreen + ANGLE/SwiftShader-WebGL)里装真页面,注入
`viewer/tests/selftest.js`:启动 / 坐标对齐 / 手性 / 相机手势(环视机位不动、环绕目标不动、
朝光标缩放光标下点不动、飞行键不漏给工具键表、正交仍能拾取)/ gizmo(单轴只动一个分量、
Ctrl 吸附是整数倍、纯点一下不入历史、选中单个东西立刻有 gizmo、2D 视图同一份 gizmo)/
巢与活动域三球缩放 / 锚点落地与落壳 / 玩家与刺激 / 群体真的对刺激起反应 / 本地预览确定性 /
保存往返与键序 / 保存锁 / 装载门 / 六条护栏拒绝 / 联动软失败。
**改 viewer 下任何东西先跑它**;新抓到的坑往里加一条 `ok()`;改相机基要顺手变异一次确认判据会红。

## 相关

- 运行时:[[vfx-system]]
- 同模子的两台:[[trajectory-workbench]]、[[acoustic-workbench]]
- 坐标与手性:[[coordinate-spaces]]
