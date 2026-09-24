---
id: scene-relight-tool
title: 场景背景重打光工作台
domain: asset-pipeline
type: mechanism
summary: 把白天原画确定性地重打光成时段/天气变体背景图的离线工作台;它只读几何烘焙产物、不自己烘;每张时段原画都要各烘一套角色照明载荷
status: active
authority:
  - tools/scene_relight/relight.py
  - tools/scene_relight/README.md
  - src/utils/sceneAppearance.ts
triggers:
  paths: ["tools/scene_relight/**", "public/resources/runtime/scenes/**"]
  topics: [重打光, relight, 时段变体, 夜景, 天气, 发光mask, timeVariants]
  tasks: [做夜景背景, 做时段变体, 做天气变体, 刷发光mask]
last_governed: 2026-09-23
---

## 是什么(一句话)

把**已画好的白天场景原画**离线重打光成时段/天气变体背景图的工作台;产物是**图**,
不是运行时效果——运行时"换一张夜原画"就是换这张图(模型见
[scene-lighting](../../runtime/mechanisms/scene-lighting.md))。

## 权威源(读代码从哪进)

`tools/scene_relight/`:用法/输入/预设与工作流全在它的 `README.md`(命令与旋钮会变,
以它为准,别在这里抄);重打光本体在 `relight.py`;变体图接进场景 JSON 后的解析在
`src/utils/sceneAppearance.ts`。

## 硬契约(违反即 bug)

- **确定性**:纯数值管线,同输入同参数必出同字节、画面结构不变。**生成模型不得进这条链**
  (风格漂 / 不可复现 / 许可证不可 ship)——这是选型层面的定论,不是本轮偏好。
- **它只读几何烘焙产物,不产**:深度/标定/天穹可见性/法线一律由角色照明实验室烘出、
  统一落 `runtime/scenes/<id>/lighting/<背景基名>/`。**别在这个工具里另起一份烘焙或另开目录**。
- **烘焙产物按第一层背景图名索引** ⇒ **每张时段原画都要各烘一套载荷**(`scene_fields --scene <id>`
  一条入口烘全部时段)。导出了夜原画却没给它烘,运行时只借白天的几何项、probe 不借——角色退成色调融入、
  场景夜里火把不亮,**只有 dev 控制台出声**(见 scene-lighting 的时段一条)。
- **写盘走原子写并自动备份**(覆盖的是工程在用的背景图);逐场景参数与发光 mask 进版本库,
  备份目录不进。

## 已知坑

- **README「产物与接线」一节已过时**:它仍说运行时"只声明了 `timeVariants` 类型、没有换图逻辑、接线前需先做
  运行时消费"——错的,`sceneAppearance.resolveSceneAppearance` 早已按当前时段解析背景,是夜景的正路。
  命令与旋钮仍以 README 为准,接线口径以 [scene-lighting](../../runtime/mechanisms/scene-lighting.md) 为准。
- **许可要分开记:代码许可 ≠ 模型权重许可**。`RESEARCH.md` 把 Marigold 总括为 Apache-2.0,但那是代码;
  其 IID 权重卡标的是 CreativeML OpenRAIL++-M(证据 `artifact/AlbedoCliff_20260907/marigold_native/lighting-model-card.md`)。
  评估任何模型能不能进离线链或随包,按**具体模型版本的权重许可**判,不拿代码许可顶替。
- **发光 mask 是作者手刷的灯位**,不是算出来的:demo 期留下的 mask 属占位(agent 猜的灯位),
  正式用前必须由美术重刷,否则夜景灯火位置是错的。
- 缺深度输入时管线**不报错,自动退化**成纯调色 + 发光(没有阴影/雾/湿地)——画面"能看",
  容易被当成"效果就这样",判断前先确认该场景有没有深度。

## 怎么验证

导出后真机进该场景、把时刻推到对应时段看换图是否生效;角色是否打上光单独看
(那是载荷有没有按变体烘的问题,不是这张图的问题)。
