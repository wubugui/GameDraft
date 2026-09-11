---
id: trajectory-workbench
title: 轨迹工作台(独立桌面应用 · 画面/世界两种空间 · 烘成独立资产)
domain: editor-tools
type: mechanism
summary: 轨迹资产唯一的作者面与唯一写入者;曲线没有锚点(播放位置在播放时给),只有一种曲线两种配置(场景曲线绑作者场景 / 相对曲线不绑),命名插槽是曲线暴露给场景的站位;加载任一场景(可把 q 空间还原成 3D 伪世界)拉线/抛体,保存=烘一次再原子写盘(保存即迁移老锚点资产);世界空间物理与地面高度场+深度壳碰撞、控制点是 {x,z,h};投影与运行时同一份金标;桌面壳零浏览器缓存
status: active
authority:
  - tools/trajectory_workbench/serve.py
  - tools/trajectory_workbench/baking.py
  - tools/trajectory_workbench/bake.py
  - tools/trajectory_workbench/bake3d.py
  - tools/trajectory_workbench/geometry.py
  - tools/trajectory_workbench/projection.py
  - tools/trajectory_workbench/assets.py
  - tools/trajectory_workbench/viewer/app.js
  - tools/trajectory_workbench/viewer/gizmo.js
  - tools/trajectory_workbench/viewer/view2d.js
  - tools/trajectory_workbench/viewer/view3d.js
  - tools/desktop_shell.py
triggers:
  paths: ["tools/trajectory_workbench/**", "public/assets/data/trajectories/**", "tools/desktop_shell.py"]
  topics: [轨迹, trajectory, 工作台, 烘焙, 时间曲线, 抛体, 拉线, sampleHz, 抽稀, 世界空间, q 空间, 深度壳, 高度场, 场景曲线, 相对曲线, binding, 命名插槽, slots, 曲线起点, origin]
  tasks: [编轨迹, 改烘焙机, 改工作台, 加分段类型, 换场景重烘, 批量重烘]
verified_by:
  - tools/trajectory_workbench/tests/test_bake.py
  - tools/trajectory_workbench/tests/test_bake3d.py
  - tools/trajectory_workbench/tests/test_projection.py
  - tools/trajectory_workbench/tests/test_assets_and_serve.py
  - tools/trajectory_workbench/tests/test_coin_roll_anchor.py
  - tools/trajectory_workbench/tests/test_viewer.py
  - tools/trajectory_workbench/tests/test_spline_parity.py
  - tools/trajectory_workbench/tests/test_bake3d_guards.py
  - tools/trajectory_workbench/tests/test_selftest.py
  - tools/trajectory_workbench/viewer/tests/math.test.cjs
  - tools/trajectory_workbench/viewer/tests/selftest.js
  - tools/editor/tests/test_trajectory_action_registration.py
last_governed: 2026-09-11
---

## 是什么(一句话)

策划怎么做出一条实体轨迹:开**轨迹工作台**(`./dev.sh trajectory-workbench` / Windows
`sh scripts/py.sh -m tools.trajectory_workbench`,主编辑器 playTrajectory 表单里也有"在轨迹工作台中打开…"),
选一个场景装进来,选一个实体当预览幽灵,**直接在画布上**画线 / 拖落点 / 拖把手,松手即重烘,保存成
`public/assets/data/trajectories/<id>.json`。运行时那一半见 [[entity-trajectory]]。

## 2026-09-11 制作人定案:曲线没有锚点,只有一种曲线两种配置

- **曲线本身没有锚点,但曲线有自己的原点。** 曲线就是画在场景里的一条路径;帧写成相对**曲线原点**的偏移,
  **播放位置在播放时给**(`playTrajectory.at`:数字 / 实体此刻位置 / 场景曲线插槽 / 曲线上的点),对齐的就是原点。
  **原点是作者摆的点,不是第一帧**(2026-09-11 第二轮,见下条);工作台里**没有锚点工具**;换预览实体**绝不**挪曲线——预览实体只是骑在曲线上的那个东西,
  它的尺寸参数(`source.bake.restHeight` = 静止时支点离地高 / `contactOffsetY` = 画面接地偏移)只在还没设过时从它取一次,右栏有"取自预览实体"按钮。
  (制作人:"锚点是播放时设置的,所以它肯定不是在轨迹编辑器里设置的"、"更换预览实体只是把实体放到曲线上,绝对不可能去改变整个曲线的位置"。)
- **曲线原点(`O` 工具 / 橙色十字)= 这条曲线自己的参考点**,与**曲线起点**(第 0 段的起点 = 运动从哪儿开始)是两回事:
  * 帧 = 绝对姿态 − 原点,所以**第一帧不恒为 (0,0)**;播放给的位置对齐原点;场景曲线不给位置就在原点原地播。
  * 作者没单独摆过时,原点跟着曲线起点(老资产与新曲线的缺省关系,画布上写"原点(跟着起点)");摆过一次就分家。
  * **挪原点不动曲线,挪起点不动原点**;"整条"变换把原点、插槽、曲线一起带走(不带原点的话"整条挪开"在播放时等于没挪)。
  * 世界空间的真相是 `authoring.originWorld`(绝对世界点,可离地),`origin` 是它的投影;右栏可改离地高、可"放到曲线起点"。
  (2026-09-11 制作人第二轮打回:"这个轨迹曲线还是需要一个自己的原点,否则曲线的起点绑死原点,导致调整运动起点导致整个曲线的位置发生变化,这是不对的!"
  ——第一版把原点钉死成第一帧,烘焙机每次拿第一帧顶掉它,于是调一下运动起点,整条曲线在播放时整体位移。)
- **只有一种曲线,配置不同(顶栏"类型"下拉,`binding`)**:
  * **场景曲线** `scene`:绑定作者场景(`authoring.sceneId` / `background`),**只能在绑定的场景里打开**(场景下拉锁死;换时段可以,进历史"换时段");
    播放可不给位置(在 `origin` 原地播);可以配**命名插槽**。
  * **相对曲线** `free`:数据里**不记场景**(存盘剥掉 `authoring.sceneId/background`),可以在**任何场景里制作、打开**——场景下拉只是换背景
    (`S.backdrop` UI 态,不进历史、不标脏,烘焙请求带 `backdrop` 让服务端知道在哪个场景烘);播放**必须给位置**。
  * 两种互切(`changeBinding`,进历史):场景 → 相对丢绑定(当前场景变背景);相对 → 场景绑定当前背景场景。其它一切(分段 / 物理 / 空间)完全一样。
- **命名插槽 `slots[{id,label,x,y,world?}]`** = 曲线暴露给场景的**站位**(不是运动对象,也不是播放位置):插槽工具 `S` 在画面 / 3D 地面上放一个,
  青绿菱形 + 标签,可选中(`slot:<id>`)、有 X/Z 贴地 gizmo、可直接拖、右栏改名 / 删;"整条"变换带着插槽一起走。其它动作
  (`moveEntityTo / jumpEntityTo / teleportEntityTo / persistNpcAt / cutsceneSpawnActor / setSceneEntityPosition`)通过 `at:{kind:'slot',trajectoryId,slotId}`
  引用它;**挪动实体到插槽不归播放轨迹管**,由外部动作调度。烘焙机给每个插槽补脚下地面的世界点,落在行走面之外出 warning。
- **保存即迁移**(`baking.py` 头注释):老资产的 `authoring.anchor/anchorWorld/anchorHeight/contactOffsetY` 仍能读——第 0 段 `startFrom:'anchor'` 时锚点只当
  段起点用;产物里剥掉它们、`source.bake.restHeight/contactOffsetY` 从旧键回填、第 0 段改成 `startFrom:'explicit'` + 明写 `start`(按 2 位小数落盘,
  烘焙也用落盘后的值),**保存一次 == 保存两次(逐字节)**,`--rebake --all` 就是批量迁移。前端打开老资产同样 `migrateLegacyAnchor`。

## 作者面怎么用(画布是主入口,右栏只做精修 —— 2026-09-04 制作人打回原型后重做)

- **工具模式**(左侧竖栏 / 快捷键):`V` 选择/移动、`P` 加点、`T` 抛体(按住拖 = 把落点拖到目标处,没有抛体段就新建)、
  `S` 插槽、`H` 平移。任何模式下中键 / 空格+左键 / 右键拖 = 平移,滚轮 = 缩放,`Home` 复位、`F` 框住轨迹,`1`/`2` 切 2D/3D。
  **没有任何分段时左键点画布 = 直接开始画线**(自动建手绘段并进加点模式),不必先去右栏找按钮。
- **选择集**:点点 / 拖点、`Shift` 多选、框选、**点曲线选段**、双击曲线插点、右键点删点、`Delete` 删点(范围是"整段"时删段)、
  `Ctrl+A` 全选点、`[` `]` 切段、方向键微移(`Shift` ×10)。
- **变换 gizmo(`viewer/gizmo.js`,2D 原画视图与 3D 视图共用同一份,Unity 的 W/E/R)**:**选中任何东西就立刻出现在轴心**——一个点也算,
  加点模式下刚加的点也带着(2026-09-11 制作人:"选中物体根本没有 gizmo / 第一次点击没有自动激活,要切换一下才看得到"——他在原画视图里选单点,
  而当时 2D 只有 ≥2 点的包围盒变换框、3D 才有轴)。`W` 移动 / `E` 旋转 / `R` 缩放,拖动时 `Ctrl` 吸附(10 wu / 15° / ×0.1),读数跟光标,悬停变黄;
  世界空间:X(画面右)/ Y(h)(竖直)/ Z(沿地面往远处)三根轴 + 面片 + 中心 / XZ 面 = 贴地走(h 不变、跟地形);画面空间:X / Y 两根轴 + 中心自由挪。
  **2D 原画里 Y 与 Z 投影重叠**(2.5D 的固有歧义),Z 整体错开 16px 画成虚线,拖拽数学仍按真实轴向(`axisParam` 用投影后的轴方向做点积);
  YZ 面在原画里是一条线,不给。单点只给移动;**gizmo 中心压在单选的那个点上时拖点仍是拖点**(拾取顺序:轴 / 面 / 环 > 把手 > 中心)。
  **幽灵(预览实体)就是"那个物体"**:点它 = 选整条,gizmo 落在曲线起点上。右栏"变换"面板可输数值,镜像按钮左右 / 上下(世界空间 = 前后)。
  钉住起点 / 抛体的段以起点为轴、自定起点的手绘段以点的质心为轴;"整条"以曲线起点为轴;轴在变换开始时记下(`_pivotNative()`,不随包围盒漂;画把手用 `gizmoPivot()` 现算的)。
  **轴心就在那个东西本身上、旁边写着选中了什么**(`gizmoPivot().label`:"点 3 / 5 个点 / 整段 · id / 整条轨迹 / 初速(箭尖)/ 最高点 / 落点 / 起点 / 插槽 · id")——
  09-11 第一版把整段 / 整条的轴心抬高 24 wu 悬在半空,制作人:"完全不知道选中了什么"。
  **抛体把手(初速箭尖 / 最高点 / 落点 / 自定起点)与插槽也是可选中的物体**(`S.sel.handle`):点一下就选中、gizmo 落在它上面,
  轴按各自的自由度裁剪(`GZ_CFG.kinds` / `build`:最高点只有 Y;落点只有 X/Z + 贴地面片(画面空间只有 X);插槽 X/Z + 贴地;初速全三轴且中心走"该高度的水平面"不跟地形),
  拖轴走 `host.handleBase / applyHandle` → 各自的设置器(`setTip / setApex / setLanding / setExplicitStart / setSlot`),不走变换管线;直接拖把手仍是原来的手势。
  **拾取顺序**(`_hit`):小目标(控制点 / 把手 / 插槽)**先于** gizmo 的轴 / 面 / 环——别的点正好躺在选中点的轴线上时点它得选它
  (09-11 制作人:"选这个点,动的是另一个点":铜钱那条的点挤在几 wu 内,全在上一个点的 84px 轴上);只有整段 / 整条的中心压在起点上时中心赢;
  然后 gizmo;然后边 / 幽灵 / 曲线。
  **画布上的曲线是几何,不是烘焙采样**:手绘段画控制点过样条的密折线(`localCurve / localCurveWorld`,不吃烘焙),烘焙采样只留刻度;
  抛体段的位置本来就是时间积分出来的,画采样。烘焙采样按时间等距,时间曲线一改快的地方就切角,看起来像"时间曲线把曲线位置改了"
  (09-11 制作人抓到)。时间曲线末键进度 ≠ 1 / 首键不在 0 时检视器出黄字(实体不走完路径,"上一段末点"接的是它停下的地方)。
  视图只提供 projector(`_proj()`:project / worldPerPx / axisParam / planePoint / groundPoint / viewPlanePoint / eyeAbove),
  3D 用射线(`rayLineParam` / `rayPlane`),2D 世界用场景标定的线性投影(解 2×2),2D 画面就是画布;拖拽结果是模型量,`Gizmo.toTransform` 换成 `Edit.T`。
  node 测试用假 projector 钉数学,自检 S4(画面 2D)/ S13(3D)/ S14(世界 2D)钉交互。
  **平移的语义**(审查 P0):钉住起点的段做不了纯平移(起点会把它吃掉),所以"整段平移"**自动把起点改成"自定"**并在状态栏说一句;
  "整条平移" = 平移全部自定起点的段 + 插槽(`transformAll`;钉住的段由上一段带着走,第 0 段恒为自定起点 = 曲线起点);"选中点"范围里钉住的 0 号点永远不动;`Ctrl+A` 在钉住的段上 = "整段"范围。
  抛体段跟着整体变换:平移不动初速,旋转转初速,**缩放 k 倍时初速缩 √k**(射程 ∝ v²/g),镜像翻对应分量。
- **抛体直接操纵**:橙色箭尖 = 初速(`Alt` = 只改竖直分量)、**绿色 ◆ 落点直接拖**(保竖直初速反解水平初速;世界空间落点跟地形,
  够不着就先把弧高抬到落点之上)、紫色 ● 最高点上下拖(保落点反解)、2D 的绿色虚线 = 地面线(**拖画布左缘的绿色把手**:
  贴地滚动的曲线常躺在线上,线本身让给曲线,把手永远抓得到)。右栏有落点 / 弧高的数值框。
  把手是本地解析解(`common.js` 的 `flight2D/3D` + `solveLanding/Apex`),真相仍是服务端定步长积分,松手后曲线以烘焙为准(带弹跳)。
  **护栏**(审查 P0-2):重力必须 > 0(表单拒 0 / 空;`g≤0` 时把手原样返回并报状态);画面空间地面线 / 落点**不能高于起点**
  (2D 地面是一条水平线,烘焙机会把起点抬到地面线——要抛到高处的桌面用世界空间),钳位会在状态栏说;
  反解出口统一 `Number.isFinite` 兜底,**任何非有限数都进不了 doc**(否则落盘成 `null`、烘焙静默变成垂直落体)。
- **世界空间**:拖点沿地面走(画面射线打行走面场);选中点上方的 ▲ 把手 / `Alt`+拖 = 改**离地高度**;加点时点在桌面 / 台阶 / 箱顶上会落在
  那个表面上(深度壳比行走面近 → 取壳),`Alt` 强制落地面;状态栏常显画面 / 世界坐标与"表面 h""[障碍]"。
  **3D 视图可直接编辑,交互按 Unity 场景视图搭**(2026-09-10 制作人打回"怎么移动相机 / 怎么自由挪点"后重做;`view3d.js` 文件头是完整表):
  * **相机**(任何工具下):右键拖 = **环视**(机位不动转头);按住右键时 `W/A/S/D` 前左后右、`Q/E` 下上**飞行**,`Shift` ×3,滚轮调飞行速度
    (飞行键在 `window` 捕获阶段被 `view3d` 吃掉,`app.onKey` 另有 `capturesKeys()` 保险——否则按住右键按 W 会切 gizmo);
    `Alt`+左键 = 环绕(绕目标点);中键 / 空格+左键 / 手形工具(`H` / `Q`)左键 = 平移;滚轮 = **朝光标缩放**(光标下的地面 / 壳 / 目标深度点在屏幕上不动);
    `Alt`+右键 = 推拉;`F` = **对准选中**(选中点 / 整段曲线 / 整条);`Home` = 整场;双击点 = 对准它。
    右上角**坐标架**:点 X/Y/Z 臂 = 从那一侧看并切**正交**(顶视 / 侧视摆点;`ortho()` 的 near 取负,机位背后也画),点中心 = 透视 ⇄ 正交
    (切换时目标深度上的画面尺寸不变:`orthoH = dist·tan(fov/2)`)。正交下拾取仍走同一套 `inv(mvp)` 射线(起点在机位背后 `far` 处,`rayGround` 够得着)。
  * **选择**(`V`):点点 = 选;`Shift` / `Ctrl`+点 = 加减选;**左键空白拖 = 框选**(`Shift` 追加、`Ctrl` 剔除);点空白(没拖动)= 清选择;点曲线 = 选整段。
  * **变换 gizmo** = 上面那份共用的 `gizmo.js`(3D 的 projector 走射线:`rayLineParam` 射线-轴最近点,轴对着视线投影 <14px 不给抓;
    面对着视线时退相机平面;环的角度用射线打 XZ 面,边缘视角退屏幕角)。轴心:选中点质心 / 整段 `_pivotNative(live)` 抬 restH+24。
    全部走 `beginTransform/applyTransform/endTransform`(每 tick 从快照重来,所以位移一律是**相对手势起点的累计量**);3px 死区,**纯点一下不算编辑**。
  * 直接操纵不经 gizmo:拖点 = 贴地走(h 不变)、▲ / `Alt` 竖直、抛体四把手、插槽标记;右键点点(没拖动)= 删点;方向键沿世界 x/z 微移。
  * 画面空间资产在 3D 里只看:左键拖 = 环绕。
- **曲线没有锚点(2026-09-11)**,上面"制作人定案"一节是权威。历史:09-04 版"拖锚点 = 整条跟着走"、09-11 上午版 `Edit.reanchor`
  (改锚点曲线不动)都已删除;运行时用 `authoring.origin`(缺了退到老资产的 `anchor`)当原地播放位置。
- **换场景**:场景曲线**不许换场景**(`_changeScene` 直接退回并出声:"绑定在 X,只能在那里打开;要在别的场景用,改成相对曲线或新建");
  相对曲线换的只是背景,曲线坐标原样(整条 gizmo 挪到想要的地方)。换时段 / 换背景后同步预览实体:doc 没变就**不标脏**
  (`_changeEntity` 用 `cleanKey()` 判),否则相对曲线换个背景就脏一次。装载失败退回原场景 / 原背景,下拉同步回去。
- **段起点谁算**(审查 P1-N1):第 0 段恒 `explicit`(起点 = 曲线起点,可拖;新建第一段时从 `authoring.origin` / 出生点回落),`explicit` 起点在前端本地算,
  只有 `previous` 才拿上一次烘焙的段边界(上一段的积分末点只有烘了才知道)。老数据里的 `startFrom:'anchor'/'entity'` 读成 `explicit`。
- **撤销 / 重做**全覆盖(`Ctrl+Z` / `Ctrl+Y`,拖拽合成一条记录,顶栏按钮带标签);`Ctrl+C/V` 复制粘贴段、`Ctrl+D` 复制段;
  新建 / 改名 / 另存 / 删除都是页内对话框(不用 `prompt()`)。**只有真改了 doc 才标脏**(纯点一下把手不算),
  不然美术在几十条资产之间看形状时每次都被问"丢弃?",迟早条件反射点丢弃。`Delete` 在抛体段上只在"整段"范围删段,否则只提示。
- **参考层**:其它段曲线、幽灵、透视缩放、场景 NPC(带首帧图)、障碍(壳比地面近的像素染红 = 抛体会撞的地方)、网格、透视轴。
**它是桌面应用**(制作人 2026-09-04 定死):入口只有桌面窗口(`tools/desktop_shell`:纯内存 profile、
NoCache、NoPersistentCookies、服务端 `no-store/no-cache/Pragma/Expires` 三件套),不走系统浏览器、不留任何浏览器缓存。
`--serve` 只是给无头验证与自动化的裸服务,不会开浏览器。单实例;第二次 `--open <id>` 把已开着的窗口切到那条资产。

## 权威源(读代码从哪进)

`serve.py` = 路由与"保存 = 烘一次再写"的唯一出口(`bake_document / save_document(doc, backdrop)`,相对曲线存盘剥场景);`baking.py` = 一份资产怎么烘
(两种空间的编排、曲线起点回填、相对化、回落帧、老锚点资产的保存即迁移、插槽脚下地面点);`bake.py` = 2D 运动学(采样器镜像、弧长参数化、时间曲线、抛体、抽稀——纯函数,零 Qt、零磁盘);
`bake3d.py` = 3D 运动学(同一套不变量,位置来自伪世界);`geometry.py` = 场景几何(q → 世界、地面高度场、深度壳、
3D 网格、实体首帧图);`projection.py` = 世界 → 画面投影(TS 镜像);`assets.py` = 资产文件读写与 id 护栏;
`viewer/` = 纯 JS 前端(2D 画布 + 裸 WebGL2 3D 视图,不引第三方库);
`bundle.py` = 把运行时 `sceneSpace.ts` + `trajectoryProjection.ts` 打成 ESM 给页面(坐标对齐自证的裁判,产物落
`viewer/_gen/`,本目录 `.gitignore` 挡住不入库;打不出来只是不显示自证,不拦着干活)。

## 资产形状(与 `types.ts` 的 `TrajectoryAsset` 逐字对齐)

```
id / label / space('screen'|'world')
binding            'scene'(场景曲线,绑作者场景)| 'free'(相对曲线,不绑;缺省按 authoring.sceneId 有无推)
keyframes[]        2D 相对帧(相对曲线起点,首帧 (0,0);screen 的真相、world 的回落帧)
worldKeyframes[]   3D 相对帧 {atMs,x,y,z,h,…}(相对 originWorld;world 的真相)
slots[]            命名插槽 {id,label?,x,y,world?}(曲线暴露给场景的站位;world 由烘焙机补)
source             分段 + 烘焙参数(工作态;bake.restHeight / contactOffsetY 是"骑在曲线上那个东西"的尺寸,不耦合实体)
authoring          sceneId / background(场景曲线才有)/ entity(预览实体,软引用)/ origin / originWorld(**作者摆的曲线原点**,缺省回填成曲线起点)
                   老键 anchor / anchorWorld / anchorHeight / contactOffsetY 只读、不再写(运行时 trajectoryOrigin 退到 anchor)
```

## 硬契约(违反即 bug)

- **本工作台是资产目录唯一的写入者。** 主编辑器只读它(选择器候选 / 校验);没有脏桶、没有 Save All 分支、
  不裁剪"内存里没有"的文件。两个写入者的下场是互删(见 [[save-all-dirty-buckets]] 的已知坑)。
- **存盘后主编辑器怎么看见(2026-09-11 制作人点名)**:工作台在另一个进程里写盘,主编辑器那份只读镜像
  (`ProjectModel.trajectories`,喂 playTrajectory 候选 / 位置引用的插槽下拉 / 曲线类型说明 / 校验)必须重读,
  **并且已经打开的页要重建控件候选**——只重读镜像的话下拉里什么都不会变(见 [[mainwindow-editor-hooks]] 契约 6)。
  三条入口都接好了:从主编辑器起的工作台进程登记进监视表 → **主窗回到前台**或**工作台退出**时自动重读(镜像真变了才重建);
  手动那一下是「工具 → 重读轨迹资产」(无条件刷当前页)。在工作台外面单独起的进程没登记,走手动那条。
- **保存 = 烘一次再写。** `source` 与 `keyframes` / `worldKeyframes` 永远是同一次烘焙的产物,原子写(`retry_transient`)。
  这次没烘出帧(段为空 / 场景没深度)时**保留磁盘上的旧帧**,绝不拿空表清盘;全新资产没帧则拒存。
- **两种空间,逐条资产选,逐条资产整体换算。**
  - `screen`:2D 画面平面(场景坐标 wu、Y 向下)。抛体重力沿 +y、地面是一条 `groundY` 水平线。
  - `world`:先把 q 空间还原成 3D 伪世界(`geometry.SceneGeometry`,下游消费照明实验室的
    `scene_geometry.Scene`,**一律用 `depthConfig.M.R`(det=+1)**,实验室 `lighting.json` 那套 det=−1 一概不碰),
    物理在 3D 里积分(+Y 向上、XZ 地面、单位 wu、`gravity` 是正的大小,≈865 = 9.8 m/s²)。
    手绘控制点是 **`{x, z, h}`**(地面坐标 + 离地高度),采样 `y = 地面(x,z) + h`,拖点过台阶曲线自动跟地形;
    `h` 在控制点之间**线性**插值(样条会在等高段之间下沉到地面以下)。
- **资产的原点是作者摆的参考点,不是第一帧、也不是任何实体的锚点。** 帧 = 绝对姿态 − `authoring.origin`(世界空间 − `originWorld`);
  烘焙机**只在它缺省时回填**成曲线起点,之后一律以作者摆的为准(顶掉它 = 调起点就整条位移,已被打回一次)。
  播放位置在播放时给(`at`),场景曲线不给就在 `origin` 原地播。世界空间抛体的贴地高度 = `source.bake.restHeight`
  (画面接地偏移 / cosθ;圆心锚的铜钱 = 半径 / cosθ),缺省从预览实体取一次,之后是资产自己的参数。
- **场景曲线只能在绑定的场景里打开;相对曲线可以在任何场景里打开、数据里不记场景。** 服务端按 `binding_of(doc)` 决定烘在哪个场景
  (相对曲线拿请求里的 `backdrop`),存盘剥掉相对曲线的 `authoring.sceneId/background`;场景曲线 `sceneId` 为空拒存。
- **命名插槽是曲线暴露给场景的站位**,只在地面上挪(gizmo X/Z + 贴地);引用它的是别的动作(`at` 位置引用),播放轨迹永远不挪任何实体到插槽。
- **地面与墙从哪来。** 地面 = 照明载荷的行走面深度场 `lighting/<背景基名>/ground_d.png` 反投影成世界 XZ 高度场
  (栅格化 + 最近邻补洞);没烘过光照的场景退回深度壳当地面(近似,会把墙也当地,状态栏会写"深度壳(近似)")。
  墙 = 深度壳里法线不朝上的像素:球心到壳的深度差 < `radius` 就算撞,沿法线反射再把球心推到壳前。
  **2.5D 只有可见壳一层,"飞到前景物体背后"也算撞**——这是制作人接受的"不需要特别精确"。
- **投影与运行时同一份数学。** `projection.py` 与 `src/utils/trajectoryProjection.ts` 共用
  `trajectoryProjection.golden.json`,逐位相等;回落 `keyframes` 从**落盘形**世界帧投出来,与运行时投的是同一份数。
  那道金标管**落盘**;管**页面**的是下面这道自证,两道都要——缺一边就是"存进去的对、作者看到的不对"。
- **🔴 页面与运行时的坐标对齐自证(2026-09-10 起,不许绕过)。** `bundle.py` 用仓库自带 rolldown 把运行时的
  `src/utils/sceneSpace.ts` + `src/utils/trajectoryProjection.ts` 打成 ESM(`/gen/runtime.bundle.js`,落 `viewer/_gen/`,
  不入库),`app.js` boot 时 `import()` 它,装完场景跑 `checkAlignment()`:
  * `dPts` —— 25 个画面点分别过**运行时的** `groundWorldAt` 与工作台的 `SceneCal.sceneToWorldGround`(管"作者点的那里 = 运行时认为的那里");
  * `dProj` —— 6 组 3D 位移分别过**运行时的** `projectWorldOffset` 与工作台的 `cal.projectOffset`(管"预览里的形状 = 开播时的形状");
  * `dRound` —— 世界 → 画面 → 世界往返(抓标定自身退化)。
  实测三项 `dPts=0 / dProj=0 / dRound≈1.9e-5 wu`(雾津街头)。对不上 → 场景芯片整块染红说明,自检 S12 红。
  **别在 JS 里再写一份换算**:两份必然漂,而且漂了一处都不报错。
- **🔴 3D 视图必须按左手系搭相机。** M-world 是 x 画面右、Y 上、**Z 进画**的**左手系**(`depthConfig.M.R` det=+1 保手性)。
  `common.js` 的 `lookAt` 是**左手写法**(`x = z × up`,基 det = −1),`view3d.js` 的 `_forward`(yaw=0 → +Z)、
  `_right`(= up × forward)、环绕机位(eye = 目标 − forward·dist)、右键平移(右 = up × forward、上 = forward × right)
  是**同一套**,单独改一边就整张画面左右镜像。⚠ 镜像**一处都不报错**:投影与拾取共用同一个 mvp 及其逆,所以完全自洽,
  只有拿原画对着看才发现(2026-09-08 声学工作台、2026-09-10 这里,制作人各抓到一次;第二次是第一次留下的预判成真)。
  判据钉在自检 S11:相机的右必须投到屏幕 +x;相机对准原画视线方向时,原画的右 / 上必须与屏幕同向。见 [[coordinate-spaces]]。
- **烘焙产物恒不写 `easing`**;**物理定步长 1/120 s 与 `sampleHz` 解耦**;**触地与静止瞬间强制成帧**;
  **抽稀用同一时刻的数值差**(误差上界可断言),2D / 3D 共用同一台抽稀机(通道表参数化,别再写第二份)。
- **手势期间不写盘。** 前端改动只落内存 doc,拖拽中 90 ms、松手后立刻调 `/api/bake` 取预览;`保存` 才写盘。
  **在飞的烘焙响应只对发出时的那份 doc 有效**(审查 P1-1):doc 修订号 `S.rev` 每次编辑 / 换场景 / 换实体 / 撤销自增,
  响应回来时修订号变了就整发丢弃;`applyBake` 只合并服务端算出来的 `anchorWorld / anchorHeight`,**绝不整份覆盖 `authoring`**
  (否则拖锚点的最后一段位移、整次换场景会被一发旧响应静默抹回)。**保存同一把锁**:`/api/save` 在飞期间又改了 doc,
  返回后不覆盖内存、不清脏标记,状态栏说"保存期间又有改动,再按一次 Ctrl+S"。撤销 / 重做后 `syncEnvWithDoc` 把场景 / 时段 / 预览实体
  重装到与 doc 一致(判据同时看已装载的 `S.scene` 和**正在装载的** `S.loadingScene`,撤销→重做落在装载途中也不会画着 A 写着 B);
  连续快换场景有 `sceneOp` 序号,后一次进来前一次整个作废;装载失败 doc 回滚到原场景并出声。
  `id` / `label` **不进历史栈**(改名 / 另存 / 名称框绕开历史;进了快照,撤销一条无关编辑就会把 id 倒回去、Ctrl+S 写错文件);另存 = 干净历史
  (失败则退回原资产、历史不丢)。**凡是不走 `afterEdit` 却直接改 `S.doc` 的地方(名称框、改名)一律 `touchDoc()` 抬修订号**,
  否则保存锁对它们失效(审查第五轮抓到的洞)。**磁盘操作一条链**(`runIO`:存 / 改名 / 删 / 另存全部串行,谁先谁后由链定,
  不看服务端处理顺序——不串就会留下两份文件或删完又被写回)。**装载门**(`setBusy`,审查第六 / 七轮):换场景 / 换实体 / 打开 /
  新建 / 撤销重装期间全屏遮罩 + `#app` **inert**(焦点停在下拉 / 输入框上也收不到键盘与鼠标)+ `onKey` 作废 + `saveAsset` 拒绝
  ——这几秒里 doc 与画布本来就不一致,任何编辑 / 存盘都是在半迁移的资产上动手;换场景 / 换实体各有序号守卫(`sceneOp` / `entityOp`),
  主编辑器 `--open` 打进来的 `__openTrajectory` 在门内一律拒。`loadScene` 所有数据到齐后**一次性提交**,中途失败上一个场景原封不动。
  撤销 / 重做后重装现场**失败** → `envBroken` 门(同一块遮罩 + "重试装载"按钮,只放行 Ctrl+Z / Ctrl+Y),直到画布与 doc 对上才放人。
  **门只挡新手势,已经按下去的手势会继续往 doc 上写**:所以手势 / 变换记着它开始时的 doc(`S.dragDoc / S.txDoc`),doc 被换掉
  (打开 / 新建 / 退回)就整个作废(`dropGestures`:清变换状态 + `history.discardDrag()`,**不回滚**),`__openTrajectory` 在手势没松开时也拒。
  **所有手势入口(拖点 / gizmo / 加点 / 抛体工具 / 拖时间键)一律走 `host.dragBegin`**——它记 `S.dragDoc`,`dragEnd` 失配时丢掉僵尸拖拽;
  直接调 `history.beginDrag` 的入口会让"新开资产的第一笔"不进历史(审查第九轮抓到)。保存成功后 doc 是服务端返回的新对象,必须 `renderAll()`
  重建检视器(旧闭包绑着孤儿对象,改数值会被静默丢弃)。**检视器渲染只读**(含时间曲线小编辑器):缺省容器只在写入闭包里补
  (`ensureManual/ensurePhysics` 只建空容器,行为缺省归烘焙机),`test_viewer.py` 钉住;时间键存储数组在写入时保持按 `atMs` 排序
  (命中序号 == 存储序号)。画面空间抛体起点若在地面线之下(上一段末点比线低),把手按"抬到地面线"算(与 `bake.simulate_physics_nodes` 同式)并在读数里提示;
  **这个状态里地面线 / 落点把手随手挪、不钳**(`setGroundY / setLanding` 只在正常态钳"线不能高于起点";钳回原始起点会让线一碰就瞬移 120 wu,
  审查第十轮)。**纯点一下任何把手都不算编辑**(不标脏、不留撤销、不往 doc 塞空容器)——时间键 `mousedown` 命中即说明 `timing.keys` 已存在,
  就地排序,不走 `ensureManual`。空时间曲线上加第一颗键先补 `0→0` / `时长→1` 两端(单键 timing 会把整段冻在那个进度上,烘焙不报警)。
  **撤销 / 重做回到上次落盘的那份就重新算干净**(`S.cleanKey` = 清脏时的历史快照 + 名称)。
  打开 / 新建时装场景失败:`captureSession/restoreSession` 整个退回原现场
  (doc、脏态、历史、下拉),再 `syncEnvWithDoc` 对齐画布——绝不能留下"doc 指着 A、画布画着 B 还能存盘"的状态。
  段起点被 `startFrom`(锚点 / 上一段末点)锚住时 0 号控制点拖不动(画成灰方块),状态栏会说;要自由起点改 `explicit`。
- **存储点 == 有效点。** `edit.js` 在每次写点前 `normalize`:把 `path.points` 整体平移到 `points[0] == 段起点`(delta 0),
  所以文件里的控制点就是画布上看到的位置;烘焙机的 delta 平移仍在(链式段的起点由上一段烘出来才知道,规范化只能拿估计值,
  真相以烘焙为准)。**世界空间存储的 h 是支点离地面的绝对高度**(烘焙机 `y = 地面 + h`),作者面显示 / 编辑的是
  `h − restH`(离地高度,0 = 贴地;restH = `source.bake.restHeight`,静止时支点离地高);变换作用在离地高度上,贴地的点缩放后仍贴地。
- **`startFrom:'anchor'` / `'entity'` 是旧写法**(曲线还有锚点的年代),读到按老锚点当段起点、存盘迁成 `explicit` + `start`;新数据一律写 `previous / explicit`,第 0 段恒 `explicit`。

## 已知坑

- **时间曲线首键必须钉在 t=0**(采样器边界是钳位,首键飘到 120ms 就是"保持首键进度",不是"从头渐变")。
- **`sampleHz` 上限 240**:采样器段长有 1ms 下限,采得越密越不准。
- **物理触地判据同时查弹起速度**(`restitution=0` 才会首次触地即贴地,否则原地死循环)。别照 types.ts 字面"修回去"。
- **Y 向下(画面)/ Y 向上(世界)两套符号**:画面空间往上抛填**负** vy,世界空间填**正**;切换空间时工作台会按 cosθ 换算,
  但作者面文案是分开写死的,别混。
- **背景图别原图直出到画布**:2048–4096 宽的 PNG 几 MB,画布每次重绘都拖;`/api/scene_bg?w=1600` 服务端缩放并缓存。
- **播放心跳只在播放时转**(rAF 不常驻):页不可见时不烧 CPU,无头截图也能"安定"。
- **`--serve` 在 `.claude/launch.json` 里用 `node scripts/pytool.cjs` 起**(预览面板找不到 `sh`);
  被 `preview_stop` 杀掉的是 node 壳,python 子进程可能留着占端口——见记忆里"TaskStop 留下 python 子进程"。
- **`test_coin_roll_anchor.py` 拿的是真实资产 `coin_drop_demo`**:帧相对曲线起点后不等式不变(y 与 sortY 同减起点 y)。2026-09-11 起它在制作人手改的
  那份资产上红(末帧沉地 1.14 wu,迁移前后一样),是数据问题不是烘焙机问题。

## 怎么验证

`sh scripts/py.sh -m pytest tools/trajectory_workbench -q -p no:cacheprovider`(采样器与投影两份跨语言金标 +
3D 不变量 + 资产读写 + 进程内真 HTTP + **前端纯逻辑的 node 测试** `viewer/tests/math.test.cjs`:样条 / 抛体正反解 /
射线 / `Edit` 规范化与变换 / `History`);**交互层的回归门是 `--selftest`**:

```bash
sh scripts/py.sh -m tools.trajectory_workbench --selftest
```

无头桌面壳(offscreen + ANGLE/SwiftShader-WebGL,3D 视图也在)里装真页面,注入 `viewer/tests/selftest.js`,在临时资产
`zz_selftest_*` 上把审查十轮反复踩的坑全跑一遍(新开资产的第一笔手势、拖点 / 框选 / gizmo / 数值零变换、抛体四把手 + g=0 +
起点在线下、时间键、保存后改数值 / 保存中改名称 / 三发并发保存 / 改名 + 保存串行 / 输入框里 Ctrl+S、手势跨 doc、换场景 ↔ 撤销重做 ↔
装载门 ↔ 装载失败回滚 ↔ envBroken 重试、世界空间新建 / 高度把手 / 换场景保高度 / 落点拾取 / 文件往返 / 3D 拖点、
**S11 投影判据(画面不是镜像的)、S12 对齐判据(工作台的世界 == 运行时的世界)**),一行一条
PASS/FAIL,有 FAIL 退出码 1,118 条 ~45 s(S4 插槽 + **曲线原点**(工具放置 / 拖它不动曲线 / 调起点不动它) / S9 场景曲线拒换场景 · 换时段进历史 · 相对曲线换背景不进历史 / S10 无锚点往返 / S13 3D 插槽);`pytest` 里 `test_selftest.py` 就是它(没 QtWebEngine 或缺 雾津街头 数据就 skip)。
**改 viewer 下任何东西先跑它,别拿审查员当回归测试**;新抓到的坑往 `selftest.js` 里加一条 `ok()`。`--selftest <path>` 可换脚本
(脚本跑完把报告写进 `window.__selftestResult`)。⚠ 脚本里派事件前重新取元素(松手会重画检视器,旧画布是孤儿)、跨撤销从 `S.doc` 重新取段、
等派生量用 `settle()`(立刻跑完挂着的烘焙)而不是 sleep、绝不在 `coin_drop_demo` 上 `saveAsset`。
⚠ `app.js` 是 classic script,`let v3` / `const S` 是**词法声明、不挂 window**——脚本里写 `window.v3` 恒为 `undefined`,
会伪装成"这台机器没 WebGL2"(2026-09-10 踩过)。一律用裸标识符 `v3` / `S`。
手工探针仍可 `--serve --port N` 起裸服务在页里合成 `MouseEvent`。改完资产必跑 `validate-data`(轨迹内容错在运行时静默跳过,只能构建期抓);
`python -m tools.trajectory_workbench --rebake --all` 能按 source 批量重烘并写回(改了烘焙机之后核对产物是否漂移)。
真机看画面走 [[entity-trajectory]] 的验证段。
