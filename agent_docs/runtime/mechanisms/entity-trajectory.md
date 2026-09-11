---
id: entity-trajectory
title: 实体轨迹动画(烘焙式 · 独立资产)运行时语义
domain: runtime
type: mechanism
summary: 一条轨迹一个资产文件、帧相对**曲线原点**(作者摆的参考点,不是第一帧);曲线没有锚点,播放位置在播放时给(at 位置引用:数字 / 实体此刻位置 / 场景曲线插槽 / 曲线上的点);运动对象是场景实体(target)或播放时临时生成的图片 / 角色模板(spawn,keep = 播完留下成场景实体进存档);场景曲线可原地播、相对曲线必须给位置;世界空间资产开播时只用 depthConfig.M.R 做一次线性投影;烘出的帧恒不写 easing;一实体一驱动,跳过=一步落终态;不驱动相机
status: active
authority:
  - src/data/types.ts#TrajectoryAsset
  - src/systems/TrajectorySystem.ts
  - src/utils/trajectoryProjection.ts
  - src/utils/trajectoryProjection.golden.json
  - src/utils/keyframeSampler.ts
  - src/utils/keyframeSampler.golden.json
  - src/core/Game.ts#playTrajectoryAsset
  - src/core/Game.ts#resolvePositionRef
  - src/core/ActionRegistry.ts#playTrajectory
  - src/utils/positionRef.ts
  - src/systems/SceneManager.ts#spawnRuntimeNpc
  - src/core/projectPaths.ts#trajectoryJsonUrl
  - src/rendering/SpriteEntity.ts#setTrajectoryOverlay
triggers:
  paths: ["src/systems/TrajectorySystem.ts", "src/utils/keyframeSampler*", "src/utils/trajectoryProjection*", "src/utils/positionRef*", "src/entities/Npc.ts", "src/entities/Player.ts", "public/assets/data/trajectories/**"]
  topics: [轨迹, trajectory, playTrajectory, 烘焙动画, 关键帧, sortY, 道具, 抛体, 世界空间, 投影, flipX, 播放位置, at, PositionRef, 位置引用, 命名插槽, slot, 曲线原点, origin, 曲线上的点, curve, spawn, 临时生成, keep, spawnedNpcs]
  tasks: [编排物件飞行, 让道具动起来, 在别的场景复用轨迹, 改关键帧采样, 改投影, 把实体挪到曲线插槽, 播放时临时生成道具]
verified_by:
  - src/systems/TrajectorySystem.test.ts
  - src/utils/keyframeSampler.test.ts
  - src/utils/trajectoryProjection.test.ts
  - src/entities/TrajectoryTargets.test.ts
  - src/rendering/SpriteEntityTrajectoryOverlay.test.ts
  - src/core/ActionRegistryTrajectory.test.ts
  - src/utils/positionRef.test.ts
  - src/core/ActionRegistryTrajectoryPreempt.test.ts
  - src/systems/CutsceneTrajectorySkip.test.ts
last_governed: 2026-09-11
---

## 是什么(一句话)

让 NPC / 玩家沿一条**编辑期就烘成密关键帧**的轨迹走(位移 + 叠加旋转 + 缩放 + 透明度 + 深度排序锚)。
**一条轨迹 = 一个独立资产文件** `public/assets/data/trajectories/<id>.json`,与任何场景、任何实体
无依赖;`playTrajectory` 在任何场景、任何位置把它挂到任何实体上播。运行时零物理、零求解,
只做"给定 t 求姿态"——所以任意时刻都能一步瞬间求值到终态。作者面见 [[trajectory-workbench]]。

2026-09-04 起取代"轨迹住在场景 JSON `trajectories` 里、目标写死在数据里、相机也能被驱动"的
原型形态(那一版的作者面卡 [[scene-trajectory-authoring]] 已 superseded)。

## 权威源(读代码从哪进)

资产形状在 `types.ts` 的 `TrajectoryAsset` 一族(**通道清单与缺省以那里为准**);装资产 / 投影 / 目标解析在
`Game.playTrajectoryAsset`;播放与仲裁在 `TrajectorySystem`;插值数学在 `utils/keyframeSampler`
(**与 parallax 共用同一份**,跨语言金标 `keyframeSampler.golden.json`);世界空间 → 画面的投影在
`utils/trajectoryProjection`(跨语言金标 `trajectoryProjection.golden.json`,Python 镜像在工作台)。
目标适配:`Npc` / `Player` 自身 implements `ITrajectoryTarget`,叠加量的落点是 `SpriteEntity.setTrajectoryOverlay`。
动作入口在 `ActionRegistry`;**能不能在过场里用查 `src/data/cutscene_action_allowlist.json`**,别背清单。

## 硬契约(违反即 bug)

- **资产文件是唯一真相,只有工作台写它。** `id == 文件名`,全局唯一;运行时按 id 惰性装载并整会话缓存,
  缺文件 warn 一次、播放以 `'cancelled'` 封口。构建期由校验器拦(`playTrajectory.trajectoryId` 悬垂 = 警告)。
  主编辑器对这个目录**只读**(选择器候选、校验),没有脏桶——它若也写,两个写入者就会互删。
- **帧是相对曲线原点的偏移,不是绝对坐标;曲线没有锚点,播放位置在播放时给(2026-09-11 制作人定案)。** `keyframes[].x/y/sortY` 都是相对量;
  原点是**作者在工作台里摆的参考点**,不是第一帧,所以**第一帧不恒为 (0,0)**(第一版钉死成第一帧,调一下运动起点整条曲线在播放时就位移,已被打回);
  开播时定一次"曲线原点放哪"(`Game.playTrajectoryAsset` 的 `resolveAnchor`),优先级:
  `at`(位置引用,见下)→ 老写法 `anchorX/anchorY`(= at point)→ **场景曲线**(`binding:'scene'`,`trajectoryBinding()`)退到
  资产里的 `authoring.origin`(缺了退到老资产的 `anchor`,`trajectoryOrigin()`)= **原地播** → **相对曲线**(`free`)退到运动对象此刻位置并 `console.warn`
  (相对曲线不绑场景,"必须给位置"是数据契约,校验器拦)。之后每帧姿态 = 采样 + 起点(x / y / sortY 三处)。
  `flipX` 把 x 与叠加旋转取反("往右抛"的资产在朝左的实体上播)。
- **位置引用 `PositionRef`(`src/utils/positionRef.ts`,所有引用某个点的动作共用)**:`{kind:'point',x,y}` / `{kind:'entity',id}`(执行那一刻该实体的位置,
  演员 → 热点)/ `{kind:'slot',trajectoryId,slotId}`(**场景曲线**暴露的命名插槽 `slots[]`,画面坐标就是作者场景的坐标;相对曲线的插槽解析为 null;
  曲线绑定的场景 ≠ 当前场景时 warn 但仍给坐标)/ **`{kind:'curve',trajectoryId,point,atMs?/progress?}`**(曲线上的点:
  `point` = `start|end|time|progress`,在烘好的帧上取值 `sampleTrajectoryOffset`,**加上这条曲线此刻的播放位置**——
  那条轨迹**正在播**就用那次播放的锚点与那次的帧(`TrajectorySystem.livePlay`,帧已按当前场景投影,所以跨场景也准;
  这就是"实时点":铜钱还在飞,`end` 取到的是它**这次**要落的地方),没在播就按场景曲线的原点算;
  相对曲线又没在播 = 没有绝对位置(内容错)。同一条资产同时挂在多个目标上时取 Map 里的第一条——要指名就用 `entity` 档)。
  `resolvePositionRef` 是 async(要装资产)。
  `moveEntityTo / jumpEntityTo / teleportEntityTo / persistNpcAt / cutsceneSpawnActor / setSceneEntityPosition` 都接 optional `at`:解析到就覆盖 x/y,
  解析不到 warn 一句退回 x/y(x/y 仍是 manifest 必填,编辑器写的是编辑期快照)。**挪实体到插槽是这些动作的事,播放轨迹从不挪任何实体到插槽。**
- **运动对象二选一**:`target`(`'player'` / 本场景 NPC id / 过场 `_cut_*`)或 `spawn`(`TrajectorySpawnSpec`:`kind:'image'`(`src` + 可选 `worldWidth/Height`)
  / `kind:'character'`(`characterId`,角色注册表)+ 可选 `anchor`(精灵锚点,缺省底中)/ `id` / `name` / `keep`)。**spawn 可以根本不在场景里**:
  `Game.spawnTrajectoryActor` 就地拼一个 `NpcDef`(图片 = `displayImage` 单帧动画包)经 `SceneManager.spawnRuntimeNpc(def,{persistent:keep})` 生成;
  两个都没有 = 整步跳过(校验器 error)。`animState` 只对场景实体生效。
- **临时生成的东西默认播完移除;`keep:true` = 播完留在终点,场景从此改变**:`commitSpawnedNpcPosition` 把它登记进 `sceneMemory.spawnedNpcs`
  (随存档序列化,`normalizeMemory` 认它),下次进场景 `SceneManager` 装完场景 NPC 后照 `spawnedNpcs` 再实例化一遍——它已是这个场景的实体,
  重构引擎 / 校验器按运行时实体看待(数据文件里没有它的 def)。不 keep 的走 `removeRuntimeNpc`,一切照旧。
  资产里的 `authoring.entity` 只是工作台重开现场用的软引用,运行时不看、重构引擎也不跟随。
- **轨迹不驱动相机。** 运镜走 `cameraFollowActor` / `cameraMove` 那一族;`kind:'camera'` 已不存在,
  过场跳过终姿的相机竞争里也没有轨迹这一项。
- **"镜头跟着运动的东西走"= `cameraFollowActor` 指那个实体**,不是位置引用(2026-09-11 制作人问过):
  位置引用是**动作执行那一瞬求一次值**,拿它当相机 target 只会把镜头摆过去然后不动;
  `cameraFollowActor` 每帧按 id 重解析实体位置(`applyCameraFollow`),而轨迹每帧写实体位置、
  且 `trajectorySystem.update` 排在相机之前,所以跟得住(镜头取的是上一帧末的位置,`snapTo` 下看不出)。
  **临时生成的运动对象也能跟**:它在运行时就是一个真 NPC(`spawnRuntimeNpc` → `getNpcById`),
  但得在 `spawn.id` 里自己给名字——留空是自动生成的 `_traj_N`,引用不了。编辑器的 actor 候选面
  已把全工程的 `spawn.id` 收进来(`ProjectModel.collect_trajectory_spawn_ids`,校验器同口径放行)。
  ⚠ 跟随只在过场 / 动作链态生效,回到探索态自动解除。
- **`cameraMove`(present 步)可选 `at`**:把镜头**摆到**位置引用给的点(数字 / 实体此刻位置 / 曲线插槽 /
  曲线上的点),一次性求值。`x`/`y` 恒在(编辑期快照 + 老数据形状),解析不出来就退回它们并 warn。
  正常播与**跳过落终姿**(`applyFinalCameraPoseForSkip`)两条路都按 `at` 求值——只做一条就是
  "播完对、跳过错"。求值口由组装层注入(`CutsceneManager.setPositionRefResolver` ← `Game.resolvePositionRef`)。
- **世界空间资产(`space:'world'`)的运行时真相是 `worldKeyframes`**(3D 相对偏移 + 离地高度 `h`),
  开播时按当前场景 `depthConfig.M.R` 投影成 2D 帧:`Δx = (RᵀΔw).x`,`Δy = −(RᵀΔw).y`,`sortY` 取落点
  `(x, y−h, z)`。**只要 R**:伪世界相机正交、q ↔ M-world 是纯旋转,ppu / cx / cy / wuPerQUnit / 分辨率全部约掉,
  所以不需要任何光照烘焙载荷,同一场景内任何位置播同一条轨迹画面偏移逐位相同,跨场景只差俯角。
  没有 `depthConfig`(或 R 不是 det=+1)的场景回落到资产里烘焙场景投好的 `keyframes`。
  播放场景的地面高低**不**参与(烘焙时的地面已进 `h`)——这是"运行时零求解"的边界。
- **运行时只播烘好的帧,`source` / `authoring` 完全忽略**——与 [[parallax-scene-runtime]] 同形。
  手改 JSON 想改运动就得改帧;只改 `source` 不重烘 = 画面一个像素都不变,而且没有任何东西会报错
  (工作台的保存 = 烘一次再写,天然不会出这种坏数据;`--rebake` 能按 source 重烘)。
- **烘焙产物恒不写 `easing`**(即 linear)。密帧本身已经把节奏烘进帧的疏密里,再叠段缓动就是**缓动做两遍**。
  跨 parallax / 轨迹的通用条款。
- **通道语义**:`rotation` 是**叠加**度数、`scale`/`scaleX`/`scaleY` 是**乘**在实例变换上的倍率、`alpha` 乘、
  `x/y` 相对锚点(wu)。`sortY` 是**深度排序的接地锚**、**缺省 = 该帧的 `y`**——飞在空中的物件靠它保持
  "落点"的前后关系;**轨迹期间实体的接地 y(`contactY`)也取它**:透视缩放、影子落点、遮挡脚点都按落点算,
  不按空中位置算(否则铜钱越抛越小、影子跟着飞)。
- **旋转绕的是实体锚点,而锚点是可配的**(`NpcDef.anchor`,缺省底中)。**圆形物件必须把锚点设到圆心**
  (`{x:0.5,y:0.5}`),否则"滚一圈"整个压进地面(实测 14 wu 铜钱半圈处低于街面 13.99 wu,不报错)。
  钉单 `tools/trajectory_workbench/tests/test_coin_roll_anchor.py`(拿真实资产逐帧断"最低点不低于接地线")。
- **采样器是哑的,喂进去之前必须把七通道填满。** 语义缺省(`sortY = y`、`scaleX/Y = scale`)是消费侧的义务
  (运行时 `normalizeFrames` 一份、Python 烘焙机一份)。漏了不报错:深度锚被当常数插值。
- **时间基是调用方传进来的 `dt`,绝不读挂钟。** 同一份帧 + 同一串 dt ⇒ 逐位相同。
- **跳过 = 一步落终态**,不是停在半路、也不是补跑一遍。过场 `skip()` 直接 `finishAll`;dev 快进同理。
- **一实体一驱动**,按 `trajectoryKey` 索引。抢占矩阵:

  | 与谁相遇 | 谁赢 |
  |---|---|
  | 同键第二条轨迹 | 新的赢,旧的以 `preempted` 封口。**仲裁在播放系统**,适配层不自我仲裁 |
  | `moveEntityTo` / `jumpEntityTo` | **位移赢**:两个入口显式掐断在途轨迹 |
  | NPC 巡逻 | **轨迹赢**:开播时先停巡逻(注入的 `suspendPatrol`) |
  | NPC 日程 | **日程赢**(它自己走 `moveTo`) |
  | 实体 `destroy` | 轨迹当场收手(生命周期对称) |
  | 切场景 / 读档 / 系统销毁 | 整批 `cancelled`:**不落姿**,并把叠加量还原 |
  | `teleportEntityTo` / `persistNpcAt` / `setSceneEntityPosition` / `moveGroupBy` | **瞬移赢**——靠各自写坐标**之前**显式调一次 `stopTrajectory`,那几行是这条路径唯一的抢占口。钉单 `ActionRegistryTrajectoryPreempt.test.ts` |
  | `Npc.steerBy`(同伴跟随) | 不触发抢占。当前无调用方;将来接跟随时要么走抢占,要么在跟随侧判 `isDriving` 回避 |

- **`moveEntityTo` 与轨迹是两个工具,不迁移。** 角色**走路**继续用 `moveEntityTo`(步速匹配 + 透视步长补偿,轨迹一概没有);
  走路之外(飞、抛、滚、被推、道具位移)一律轨迹。
- **道具 = 没有动画包的普通 NPC**(`NpcDef.displayImage` 就地合成单帧动画包)。别为"一口箱子"新造实体类型;`spawn.kind:'image'` 走的就是这条路。
- **资产层的两种配置**:`binding:'scene'`(场景曲线,`authoring.sceneId` 必有;可原地播;可有 `slots`)/ `'free'`(相对曲线,数据里没有场景;必须给 `at`;插槽无意义)。
  缺省按 `authoring.sceneId` 有无推(老资产)。编辑器侧一律经统一的位置引用选择器(`tools/editor/shared/position_ref_field.py`,见 [[trajectory-workbench]] / [[shared-widget-value-fidelity]])配 `at`。

## 已知坑

- **镜像在旋转的内层还是外层,决定叠加旋转要不要补符号。** 镜像住在**同一节点自己的 `scale.x`**(玩家)时在 R 内层,
  取反反而是 bug;住在**外层容器**(NPC)时 `M·R(θ) = R(−θ)·M`,必须补符号。补偿数学收在 `setTrajectoryOverlay`
  的显式入参里一处。传错不报错,只是工作台预览顺时针、游戏里逆时针。
- **`sortY` 会和"未旋转即删排序锚键"打架**:NPC 的排序脚点同步在无旋转时会 `delete` 那个键——轨迹期间上独占锁,
  不靠调用顺序。
- **接地 y 必须在写位置之前落**:`Npc.applyTrajectoryPose` 先写 `_trajectoryContactY = pose.sortY` 再写 `x/y`,
  因为位置 setter 一路下推到透视刷新,刷新按 `contactY` 采样;顺序反了这一帧的透视系数就按空中位置算。
- **玩家的位置写入天生晚一帧**,适配里必须立刻 `syncPositionNow()`。
- **过场里第一次播某资产要 fetch 一次**——若过场恰在那一瞬被跳过,`finishAll` 先于开播,轨迹会在过场结束后才起步。
  所以过场引用的资产在开机 `cutsceneManager.loadDefs()` 之后**预载**(`preloadCutsceneTrajectoryAssets`);
  热区 / 对话里的引用仍是惰性装载(那些路径没有"跳过"语义)。
- **逐位确定性断言的 dt 必须是精确二进制小数**(1/64、1/32),拿 1/60 去写红了分不清是谁错。
- **轨迹更新在主循环里的位置有两个硬约束,别挪:** 在所有状态分支**之后**、相机 `update` 与实体排序**之前**。
- **轨迹是表演态,不入档。** 读档 = 换时间线,在途整批作废;玩家跨场景长活、不在任何卸载名单里,切场景停轨迹是
  播放系统自己的责任(见 [[teardown-ordering]])。
- **`stopTrajectory` 对"目标身上没有轨迹在跑"刻意不告警**。
- **相邻缺口(未修)**:`CutsceneManager.skip()` 至今不取消在途 `moveEntityTo`。详见 [[cutscene-step-semantics]]。

## 怎么验证

- 单元:`verified_by` 那八个文件覆盖锚点 / 仲裁 / 封口 / 快进 / 镜像符号 / 接地 y / 跳过终姿 / 两份金标逐位。
  改插值或投影数学 = 改跨语言契约,TS 与 Python 两侧金标必须同改
  (`tools/trajectory_workbench/tests/test_bake.py` / `test_projection.py` 逐 case 读同一份金标)。
- 真机:先 `validate-data` 过构建期结构校验(轨迹的内容错在运行时**一律静默跳过**);再走
  [runtime-command-channel](../recipes/runtime-command-channel.md) 用 `debugExecuteAction` 直发
  `playTrajectory {trajectoryId, target | spawn, at?}`,配 `debugSetFixedTickMode` + `debugStepTicks` 做定步长复现;
  曲线点的"实时"档要在轨迹**在播的那几帧里**发下一条动作才看得出来(定步长 + 分步发最稳);
  要看画面按 [headless-visual-verification](../recipes/headless-visual-verification.md) 出帧。
- 判"轨迹到底在不在跑"别只看位置:位置对而旋转/透明/排序没动,是"喂进采样器前没填满通道"的典型相。
