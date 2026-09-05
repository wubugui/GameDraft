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
  - public/resources/runtime/scenes
triggers:
  paths: ["tools/character_lighting_lab/**", "public/resources/runtime/scenes/**"]
  topics: [场景烘焙, 碰撞图, 深度图, depthConfig, 出生点, 可走性]
  tasks: [烘场景深度, 新增场景碰撞, 体检出生点, 下线烘焙字段]
last_governed: 2026-08-05
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

## 已知坑

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
