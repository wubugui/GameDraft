---
id: entity-trajectory
title: 实体轨迹动画(烘焙式 · 独立资产)运行时语义
domain: runtime
type: mechanism
summary: 一条轨迹一个资产文件、帧相对播放锚点;playTrajectory 按全局 id 装资产、挂任何实体、在任何位置起播;世界空间资产开播时只用 depthConfig.M.R 做一次线性投影;烘出的帧恒不写 easing;一实体一驱动,跳过=一步落终态;不驱动相机
status: active
authority:
  - src/data/types.ts#TrajectoryAsset
  - src/systems/TrajectorySystem.ts
  - src/utils/trajectoryProjection.ts
  - src/utils/trajectoryProjection.golden.json
  - src/utils/keyframeSampler.ts
  - src/utils/keyframeSampler.golden.json
  - src/core/Game.ts#playTrajectoryAsset
  - src/core/ActionRegistry.ts#playTrajectory
  - src/core/projectPaths.ts#trajectoryJsonUrl
  - src/rendering/SpriteEntity.ts#setTrajectoryOverlay
triggers:
  paths: ["src/systems/TrajectorySystem.ts", "src/utils/keyframeSampler*", "src/utils/trajectoryProjection*", "src/entities/Npc.ts", "src/entities/Player.ts", "public/assets/data/trajectories/**"]
  topics: [轨迹, trajectory, playTrajectory, 烘焙动画, 关键帧, sortY, 道具, 抛体, 世界空间, 投影, flipX, 锚点]
  tasks: [编排物件飞行, 让道具动起来, 在别的场景复用轨迹, 改关键帧采样, 改投影]
verified_by:
  - src/systems/TrajectorySystem.test.ts
  - src/utils/keyframeSampler.test.ts
  - src/utils/trajectoryProjection.test.ts
  - src/entities/TrajectoryTargets.test.ts
  - src/rendering/SpriteEntityTrajectoryOverlay.test.ts
  - src/core/ActionRegistryTrajectory.test.ts
  - src/core/ActionRegistryTrajectoryPreempt.test.ts
  - src/systems/CutsceneTrajectorySkip.test.ts
last_governed: 2026-09-04
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
- **帧是相对播放锚点的偏移,不是绝对坐标。** `keyframes[].x/y/sortY` 都是相对量;开播时定一次锚点
  (`playTrajectory.anchorX/anchorY` 显式给,否则 = 目标此刻位置 `readTrajectoryAnchor()`,
  读在同键旧轨迹被收掉**之后**,所以接着上一条的终姿播),之后每帧姿态 = 采样 + 锚点(x / y / sortY 三处)。
  `flipX` 把 x 与叠加旋转取反("往右抛"的资产在朝左的实体上播)。
- **`target` 必填**(`'player'` 或 NPC id)。资产与实体无关,挂谁由动作说;资产里的 `authoring.entity`
  只是工作台重开现场用的软引用,运行时不看、重构引擎也不跟随。
- **轨迹不驱动相机。** 运镜走 `cameraFollowActor` / `cameraMove` 那一族;`kind:'camera'` 已不存在,
  过场跳过终姿的相机竞争里也没有轨迹这一项。
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
- **道具 = 没有动画包的普通 NPC**(`NpcDef.displayImage` 就地合成单帧动画包)。别为"一口箱子"新造实体类型。

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
  `playTrajectory {trajectoryId, target}`,配 `debugSetFixedTickMode` + `debugStepTicks` 做定步长复现;
  要看画面按 [headless-visual-verification](../recipes/headless-visual-verification.md) 出帧。
- 判"轨迹到底在不在跑"别只看位置:位置对而旋转/透明/排序没动,是"喂进采样器前没填满通道"的典型相。
