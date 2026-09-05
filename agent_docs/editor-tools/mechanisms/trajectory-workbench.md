---
id: trajectory-workbench
title: 轨迹工作台(独立桌面应用 · 画面/世界两种空间 · 烘成独立资产)
domain: editor-tools
type: mechanism
summary: 轨迹资产唯一的作者面与唯一写入者;加载任一场景(可把 q 空间还原成 3D 伪世界)拉线/抛体,保存=烘一次再原子写盘;世界空间物理与地面高度场+深度壳碰撞、控制点是 {x,z,h};投影与运行时同一份金标;桌面壳零浏览器缓存
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
  - tools/desktop_shell.py
triggers:
  paths: ["tools/trajectory_workbench/**", "public/assets/data/trajectories/**", "tools/desktop_shell.py"]
  topics: [轨迹, trajectory, 工作台, 烘焙, 时间曲线, 抛体, 拉线, sampleHz, 抽稀, 世界空间, q 空间, 深度壳, 高度场]
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
last_governed: 2026-09-04
---

## 是什么(一句话)

策划怎么做出一条实体轨迹:开**轨迹工作台**(`./dev.sh trajectory-workbench` / Windows
`sh scripts/py.sh -m tools.trajectory_workbench`,主编辑器 playTrajectory 表单里也有"在轨迹工作台中打开…"),
选一个场景装进来,选一个实体当预览幽灵,**直接在画布上**画线 / 拖落点 / 拖把手,松手即重烘,保存成
`public/assets/data/trajectories/<id>.json`。运行时那一半见 [[entity-trajectory]]。

## 作者面怎么用(画布是主入口,右栏只做精修 —— 2026-09-04 制作人打回原型后重做)

- **工具模式**(左侧竖栏 / 快捷键):`V` 选择/移动、`P` 加点、`T` 抛体(按住拖 = 把落点拖到目标处,没有抛体段就新建)、
  `A` 锚点、`H` 平移。任何模式下中键 / 空格+左键 / 右键拖 = 平移,滚轮 = 缩放,`Home` 复位、`F` 框住轨迹,`1`/`2` 切 2D/3D。
  **没有任何分段时左键点画布 = 直接开始画线**(自动建手绘段并进加点模式),不必先去右栏找按钮。
- **选择集**:点点 / 拖点、`Shift` 多选、框选、**点曲线选段**、双击曲线插点、右键点删点、`Delete` 删点(范围是"整段"时删段)、
  `Ctrl+A` 全选点、`[` `]` 切段、方向键微移(`Shift` ×10)。
- **变换框(gizmo)**:选中 ≥2 个点、或范围切到"整段 / 整条"时出现:拖中心方块移动、拖角缩放、拖上方圆点旋转(`Shift` 吸附 15°);
  右栏"变换"面板可输数值,镜像按钮左右 / 上下(世界空间 = 前后)。钉住起点的段以起点为轴;"整条"以锚点为轴;轴在变换开始时记下(不随包围盒漂)。
  **平移的语义**(审查 P0):钉住起点的段做不了纯平移(起点会把它吃掉),所以"整段平移"**自动把起点改成"自定"**并在状态栏说一句;
  "整条平移" = **挪锚点**(帧相对锚点,自定起点的段由锚点带着一起走);"选中点"范围里钉住的 0 号点永远不动;`Ctrl+A` 在钉住的段上 = "整段"范围。
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
  **3D 视图可直接编辑**:射线打高度场 / 深度壳拾取,拖点在其高度的水平面上走,▲ / `Alt` 竖直;整段 / 整条范围有蓝色移动把手(沿地面平移,
  旋转 / 缩放用右栏数值);`Shift`+空白拖 = 框选;左键空白拖 = 环绕(**没拖动才算点空白清选择**);右键平移;方向键沿世界 x/z 微移。
- **锚点**:画布上的十字可直接拖,拖锚点 = 整条轨迹整体跟着走(帧相对锚点;**自定起点的段也一起平移**,画布 == 烘出来的);
  首段起点不在锚点上时画布画出"起点偏移"虚线,别把播放偏移当成没画上。`A` 点选放置;"取实体位置"一键回到预览实体脚下。
- **换场景的护栏**(审查 P1-2 / P0-N1):锚点必须落在新场景画面里且脚下有行走面(`SceneCal.inGroundBounds`),否则自动放到出生点并报状态;
  换场景中途 `setAnchorScreen(..., carry=false)` **只改锚点、绝不规范化**(cal 已是新场景、锚点还是旧坐标,那一刻的 delta 是跨场景的垃圾),
  形状由 `captureRelative/applyRelative` 按锚点相对量搬 x/z,**h 剖面刚性不变**(存储值可能整体滑动 <1 wu 的几何残差:
  客户端高度场 vs 服务端 anchorWorld;node 测试钉的是剖面差,别拿字面值断言)。`normalize` 是纯刚性平移、**不裁 h**;
  烘焙机 `_pt_xzh` 也**不在读入时钳 h**,钳 0 只在"整体平移到段起点之后"做(与前端 `effPointsWorld` 同式,`test_bake3d_guards.py`),
  钻地与采样点落在行走面之外都出 warning——前后端哪边先裁 h,画布和烘焙就会一个画弧一个贴地拖行,而且没人报错。
- **段起点谁算**(审查 P1-N1):`anchor` / `explicit` 起点在前端本地算(拖锚点、整条平移时曲线实时跟手),只有 `previous`
  才拿上一次烘焙的段边界(上一段的积分末点只有烘了才知道)。
- **撤销 / 重做**全覆盖(`Ctrl+Z` / `Ctrl+Y`,拖拽合成一条记录,顶栏按钮带标签);`Ctrl+C/V` 复制粘贴段、`Ctrl+D` 复制段;
  新建 / 改名 / 另存 / 删除都是页内对话框(不用 `prompt()`)。**只有真改了 doc 才标脏**(纯点一下把手不算),
  不然美术在几十条资产之间看形状时每次都被问"丢弃?",迟早条件反射点丢弃。`Delete` 在抛体段上只在"整段"范围删段,否则只提示。
- **参考层**:其它段曲线、幽灵、透视缩放、场景 NPC(带首帧图)、障碍(壳比地面近的像素染红 = 抛体会撞的地方)、网格、透视轴。
- **换场景不丢形状**:控制点按"相对锚点"换算到新场景(`Edit.captureRelative/applyRelative`);换预览实体时静止离地高变了,
  存储的绝对 h 整体跟着挪。

**它是桌面应用**(制作人 2026-09-04 定死):入口只有桌面窗口(`tools/desktop_shell`:纯内存 profile、
NoCache、NoPersistentCookies、服务端 `no-store/no-cache/Pragma/Expires` 三件套),不走系统浏览器、不留任何浏览器缓存。
`--serve` 只是给无头验证与自动化的裸服务,不会开浏览器。单实例;第二次 `--open <id>` 把已开着的窗口切到那条资产。

## 权威源(读代码从哪进)

`serve.py` = 路由与"保存 = 烘一次再写"的唯一出口;`baking.py` = 一份资产怎么烘(两种空间的编排、锚点换算、
相对化、回落帧);`bake.py` = 2D 运动学(采样器镜像、弧长参数化、时间曲线、抛体、抽稀——纯函数,零 Qt、零磁盘);
`bake3d.py` = 3D 运动学(同一套不变量,位置来自伪世界);`geometry.py` = 场景几何(q → 世界、地面高度场、深度壳、
3D 网格、实体首帧图);`projection.py` = 世界 → 画面投影(TS 镜像);`assets.py` = 资产文件读写与 id 护栏;
`viewer/` = 纯 JS 前端(2D 画布 + 裸 WebGL2 3D 视图,不引第三方库)。

## 资产形状(与 `types.ts` 的 `TrajectoryAsset` 逐字对齐)

```
id / label / space('screen'|'world')
keyframes[]        2D 相对帧(screen 的真相;world 的回落帧)
worldKeyframes[]   3D 相对帧 {atMs,x,y,z,h,…}(world 的真相)
source             分段 + 烘焙参数(工作态)
authoring          sceneId / background / entity / anchor / contactOffsetY / anchorWorld / anchorHeight(重开现场)
```

## 硬契约(违反即 bug)

- **本工作台是资产目录唯一的写入者。** 主编辑器只读它(选择器候选 / 校验);没有脏桶、没有 Save All 分支、
  不裁剪"内存里没有"的文件。两个写入者的下场是互删(见 [[save-all-dirty-buckets]] 的已知坑)。
- **保存 = 烘一次再写。** `source` 与 `keyframes` / `worldKeyframes` 永远是同一次烘焙的产物,原子写(`retry_transient`)。
  这次没烘出帧(段为空 / 场景没深度)时**保留磁盘上的旧帧**,绝不拿空表清盘;全新资产没帧则拒存。
- **两种空间,逐条资产选,逐条资产整体换算。**
  - `screen`:2D 画面平面(场景坐标 wu、Y 向下)。抛体重力沿 +y、地面是一条 `groundY` 水平线。
  - `world`:先把 q 空间还原成 3D 伪世界(`geometry.SceneGeometry`,下游消费照明实验室的
    `scene_geometry.Scene`,**一律用 `depthConfig.M.R`(det=+1)**,实验室 `lighting.json` 那套 det=−1 一概不碰),
    物理在 3D 里积分(+Y 向上、XZ 地面、单位 wu、`gravity` 是正的大小,≈865 = 9.8 m/s²)。
    手绘控制点是 **`{x, z, h}`**(地面坐标 + 离地高度),采样 `y = 地面(x,z) + h`,拖点过台阶曲线自动跟地形;
    `h` 在控制点之间**线性**插值(样条会在等高段之间下沉到地面以下)。
- **锚点是资产的原点。** `authoring.anchor` = 烘焙时的播放锚点(画面 wu,缺省取预览实体位置);帧写成相对量。
  世界空间:锚点 = 画面锚点脚下的地面点抬 `anchorHeight = contactOffsetY / cosθ`
  (画面上的接地偏移是竖直高度的正交投影;圆心锚的铜钱 = 半径 / cosθ)。
- **地面与墙从哪来。** 地面 = 照明载荷的行走面深度场 `lighting/<背景基名>/ground_d.png` 反投影成世界 XZ 高度场
  (栅格化 + 最近邻补洞);没烘过光照的场景退回深度壳当地面(近似,会把墙也当地,状态栏会写"深度壳(近似)")。
  墙 = 深度壳里法线不朝上的像素:球心到壳的深度差 < `radius` 就算撞,沿法线反射再把球心推到壳前。
  **2.5D 只有可见壳一层,"飞到前景物体背后"也算撞**——这是制作人接受的"不需要特别精确"。
- **投影与运行时同一份数学。** `projection.py` 与 `src/utils/trajectoryProjection.ts` 共用
  `trajectoryProjection.golden.json`,逐位相等;回落 `keyframes` 从**落盘形**世界帧投出来,与运行时投的是同一份数。
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
  真相以烘焙为准)。**世界空间存储的 h 是锚点离地面的绝对高度**(烘焙机 `y = 地面 + h`),作者面显示 / 编辑的是
  `h − restH`(离地高度,0 = 贴地;restH = 锚点静止离地高 = `contactOffsetY/cosθ`);变换作用在离地高度上,贴地的点缩放后仍贴地。
- **`startFrom:'entity'` 是旧写法**,读到按 `'anchor'` 处理;新数据一律写 `anchor / previous / explicit`。

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
- **`test_coin_roll_anchor.py` 拿的是真实资产 `coin_drop_demo`**:帧相对锚点后不等式不变(y 与 sortY 同减锚点 y)。

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
装载门 ↔ 装载失败回滚 ↔ envBroken 重试、世界空间新建 / 高度把手 / 换场景保高度 / 落点拾取 / 文件往返 / 3D 拖点),一行一条
PASS/FAIL,有 FAIL 退出码 1,~45 s;`pytest` 里 `test_selftest.py` 就是它(没 QtWebEngine 或缺 雾津街头 数据就 skip)。
**改 viewer 下任何东西先跑它,别拿审查员当回归测试**;新抓到的坑往 `selftest.js` 里加一条 `ok()`。`--selftest <path>` 可换脚本
(脚本跑完把报告写进 `window.__selftestResult`)。⚠ 脚本里派事件前重新取元素(松手会重画检视器,旧画布是孤儿)、跨撤销从 `S.doc` 重新取段、
等派生量用 `settle()`(立刻跑完挂着的烘焙)而不是 sleep、绝不在 `coin_drop_demo` 上 `saveAsset`。
手工探针仍可 `--serve --port N` 起裸服务在页里合成 `MouseEvent`。改完资产必跑 `validate-data`(轨迹内容错在运行时静默跳过,只能构建期抓);
`python -m tools.trajectory_workbench --rebake --all` 能按 source 批量重烘并写回(改了烘焙机之后核对产物是否漂移)。
真机看画面走 [[entity-trajectory]] 的验证段。
