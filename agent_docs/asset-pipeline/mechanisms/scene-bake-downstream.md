---
id: scene-bake-downstream
title: 场景烘焙产物的下游契约(深度/碰撞)
domain: asset-pipeline
type: mechanism
summary: 导出 depthConfig 等于第一次给场景装墙——必跑 audit-walkable;出生点落墙=玩家冻结,NPC 落墙多为有意;废字段下线要扫三类静默下游
status: active
authority:
  - tools/character_lighting_lab/audit_walkable.py
  - tools/character_lighting_lab/audit_depth.py
  - tools/character_lighting_lab/pipeline.py#export_scene_depth
  - tools/character_lighting_lab/terrain_compose.py
  - public/resources/runtime/scenes
triggers:
  paths: ["tools/character_lighting_lab/**", "public/resources/runtime/scenes/**"]
  topics: [场景烘焙, 碰撞图, 深度图, depthConfig, 出生点, 可走性]
  tasks: [烘场景深度, 新增场景碰撞, 体检出生点, 下线烘焙字段]
last_governed: 2026-09-23
---

## 是什么(一句话)

场景深度/碰撞是**烘焙出来的素材**(场景 JSON 的 `depthConfig` + runtime 的深度/碰撞图);
这张卡只管烘完之后欠下的下游义务,运行时怎么消费归 runtime 域。

## 权威源(读代码从哪进)

烘焙导出 `pipeline.py#export_scene_depth`;两道体检 `./dev.sh audit-depth`(字段/落点一致性)
与 `./dev.sh audit-walkable`(可走性)。

## 硬契约(违反即 bug)

- **给一张原本没有碰撞的场景导出 `depthConfig` = 第一次给它装墙**。出生点、巡逻点是在"哪儿
  都能站"的前提下摆的,装墙后可能正好落在墙里,**运行时不报错**,只表现为"玩家生成后卡住不
  动"。所以新增或重导任一场景的碰撞,必须连带跑 `audit-walkable`;**出生点落在阻挡格是硬
  bug,必须修**。
- **体检判据必须与运行时同源**:audit 走 `SceneDepthSystem.isCollision` 的同一条反投影链路
  (世界坐标 → 行走面深度 → M-world → 碰撞格)。另写一套"近似"口径就失去裁决资格。
- **自动修只许动出生点**:`--fix-spawns` 不动 NPC,超过位移阈值的一律保留待人工——落点是内容,
  批量吸附会把摆好的场面打散。
- **删/改烘焙导出字段(或删烘焙工具)必须做下线扫描**,三类下游会把错误**吞成静默失败**:
  ①服务端 API 的回包字段(KeyError 被外层 except 吞成"导出失败",于是每次导出都假报错);
  ②旁支实验工具(读到 undefined → NaN,画面静默错);③**已构建的 dist 产物**(重构建才消)。
  另加一类不静默但很烦的:提示文案与文档里指向已删工具的入口。

## 2026-09-14 起:碰撞的作者面搬进地形工作台

- 烘焙器导出深度时**不再写** `depthConfig.collision`,只留自动结果 `runtime/scenes/<id>/terrain/collision_auto.png`
  (`terrain_compose.record_auto`),再由唯一合成器 `terrain_compose.export_terrain` 把自动结果 ⊕ 作者层合成
  `collision.png` + **`collision.json` 旁挂**(网格声明,运行时先读它、没有才退回老的 `depthConfig.collision`)。
  行走面同理:导出时留 `ground_base.png`,`ground_d.png` = 基底 ⊕ 作者高度修补。
- **重烘 / 手动标定之后作者层原样叠回去**(多边形 / 笔刷 / 高度增量都是世界网格坐标,不随重烘丢);实验室里那套
  屏幕空间碰撞笔刷(`collision_edit.png`,`/api/save_edit?kind=collision`)已下线(410),已有的三张经
  `tools/migrate_terrain_authoring.py` 落成世界笔刷层。改碰撞一律去地形工作台,见 [[terrain-workbench]]。
- 体检:`audit-walkable --reach`(连通性)现在也是 `validate-data` 的 error;`python -m tools.terrain_workbench --check`
  一次跑完形状 + 磁盘一致 + 连通性。

## 已知坑

- **首烘新场景的三个静默坑**(2026-09-08 六个回音场景首烘踩到,都要先烧几分钟才报):
  ① 实验室管线是被**当脚本**起的(GUI 也这么起),模块里新写的相对 import 会炸在 probes 阶段——一律写绝对 import;
  ② 物体识别强制离线载权重,本机缓存里没有就直接失败,先经代理预下载一次再烘;
  ③ 若干处不带 encoding 读 JSON,中文场景名下要带 `PYTHONUTF8=1` 起。一场全管线约数分钟,深度与掩膜按背景哈希缓存;
  多场景**串行**烘,别并行;停后台烘焙后核一次子进程真的死了(停掉父任务不等于子进程退出,两个进程会并发写同一批产物)。
- **"峭壁上一条窄路"的构图,自动地面标定会塌成一张正对相机的平面**(2026-09-14,崖墓前段 / 崖墓前段1)。
  单目深度在这种画上几乎不随屏幕高度变,`stage_calibrate` 的"地面尽量水平"目标会被网格搜索推到边界
  (`s≈0.008, o=50`,深度 ≈ 常数)。俯角 45° 时这张平面的朝上余弦恰是 sin45°=0.707,低于缺省
  `ground_up_dot=0.75` ⇒ 地面掩膜为空 ⇒ 行走面被留成世界 Y=0 平面、整个落在可见表面后面:
  碰撞 / 遮挡 / 手持光源全错,**而导出照样成功**(09-08 首烘就这样静默导出,09-14 查"火把照不亮"才发现)。
  实测换提示词(崖壁算物体 / 路算地面)、俯角 55–75° 都救不回起伏。现在的处置:
  ① `build` 在地面掩膜为空时**直接抛错**,`validate.py` 对载荷里 `cal.ground_y_p95 < 0` 报 error;
  ② ⛔ **反面教材,不是处置**:崖墓前段 / 崖墓前段1 / 崖墓后段曾以 `--ground_up_dot 0.7` 重烘,
  标定塌成常数(前段1 是 s=0.95 但 o=17.7,视差项被淹没,同样≈常数),**运行时深度图是一整块平面**,
  推断出来的崖面 / 栈道结构全被抹掉。"行走面与深度图吻合 95%"是两边塌成同一平面的**假吻合**,
  火把变亮只是灯落在了平面上;遮挡 / 影子 / 碰撞都失去真实几何,制作人看碰撞 mask 判为"乱画"。
  **判据:重烘后必须把运行时深度图画出来看**(不是只看吻合率),近乎单色 = 标定塌了。
  制作人 2026-09-14 决定**亲自在实验室手动标定**这些场景,别再自动调参去"修"。
  深度推断(Depth Anything 原始视差)在这些画上是有结构的,坏的是"地面尽量水平"拟合 s/o 这一步。
  ⚠ **重烘深度会改碰撞,光跑 `audit-walkable`(只查落点是否阻挡)不够,必须查连通**:崖墓前段1 的 `spawn_1`
  (从崖墓前段进来的落点)与崖墓后段的出口 `T_到前段1` 重烘后都被切成孤岛,落点本身却都"可走"。
  两处用实验室的碰撞笔刷层 `out/<场景>/background/collision_edit.png`(R=1 强制可走)沿画里的路补通后重烘。
  判据:从每个出生点 flood fill 可走格,每个 transition 热点都要够得着。
  ③ **多层台地构图:`--ground_flood all`**(崖墓正式、崖墓前段1)。`_ground_mask_from` 缺省只收与画面底边
  连通的朝上块(挡屋顶),崖墓正式的院坝 / 上栈道 / 下崖台之间隔着竖直崖面、朝上候选断开,于是只捡到
  最下面那层 —— 阈值怎么调都把地面放错层(0.7 时"地面"甚至落到墓室墙面上)。`ground_flood='all'`
  另收面积 ≥ `ground_min_component_frac`(缺省 1% 画幅)的独立朝上块,缺省阈值 0.75 下地面掩膜正好是
  院坝 + 栈道 + 下崖台 + 台阶(`tests/test_ground_mask.py` 钉着口径)。崖墓前段1 路顶那一截同理
  (开之前出生点处行走面差 ~40 wu,火把只有 1.0×)。
  ⚠ 但 `stage_walk_world` 在这种几何上仍会把碰撞算反(墙可走、院坝封死),崖墓正式的碰撞是**用地面掩膜
  生成的碰撞笔刷层**定的:闭运算(半径 5 px,跨过松树这类小遮挡)后的地面掩膜 = 强制可走,其余 = 强制阻挡。
  开 'all' 之前先确认物体掩膜把屋顶 / 墓龛这类"朝上但不是地"的东西扣干净了。
  真正的崖壁起伏要在角色照明实验室里手画(深度笔刷),不要再调阈值去拟合。

- **NPC 落在阻挡格通常是有意的**(室内坐桌、靠柜、装饰位),不要当 bug 去挪。
- **cutscene 位移不受碰撞约束**:`Player/Npc.cutsceneUpdate` 直接朝目标推进、完全不查碰撞,
  过场 `moveEntityTo` 的目标落在阻挡格里演员照样直达。**拿过场目标点去查碰撞必是假阳性**
  (已经犯过一次并整段删除)。要审"位移会不会卡",对象只能是走普通 `update` 的位移(玩家自由
  移动、NPC 巡逻、反应式移动)。
- 旁支实验工具依赖已废字段时,宁可让它**当场抛异常**并提示改用现役工具,也别让它静默出 NaN。
- **导出深度是"一次运行写两个版本控制面":场景 JSON 的 `depthConfig` 走 git,深度/碰撞图走 DVC。
  事后只回退其中一侧就会把这一对拆散**——图是新的、声明是旧的,运行时**不报错**,只是按旧声明
  的尺寸去读新图,越界的那些格恒判"可走"。`audit-depth` 报"碰撞图与声明不符"就是这个信号。
  判哪一侧是真相不用猜:拿行走面深度反投影出实际范围看哪套声明装得下、拿出生点与带碰撞面的
  NPC 当"已知可站"的样本试、把阻挡格叠回背景图肉眼比对——三招同时指向一侧才动手。
  **对齐声明通常比强行重烘便宜。**

## 怎么验证

`./dev.sh audit-walkable`(先 `--suggest` 只报不改看清单,再 `--fix-spawns=apply --max-move=N`)
+ `./dev.sh audit-depth`;改完真机进场看玩家能否四向迈出。
