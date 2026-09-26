---
id: burn-system
title: 燃烧系统(可燃物模板 · 宿主实例化 · 确定性燃烧模拟 · 点火表演 · 离场照推与存档)
domain: runtime
type: mechanism
summary: 可燃物是模板(图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光,和场景无关),热点 / NPC / 演出生成物 / 挂件预设身上写 burnable 引用它 = 实例化一次、渲染由实例接管,粒子薄片 plate.burnable 绑它;场景实例进每场景一份事件驱动的确定性模拟(活跑 / 重放 / 离场照推逐位相同,挪位 / 出现 / 收掉也是外部事件),推不出来 ⇒ 整场切烧完;手上的挂件单独一份模拟存快照;燃烧读的是作者那份场景风(不含阵风);玩家点火 = 走到闭式解出的站位、接触帧火头对准着火点
status: active
authority:
  - src/data/burnables.ts
  - src/systems/burn/BurnSystem.ts
  - src/systems/burn/burnSim.ts
  - src/systems/burn/burnGeometry.ts
  - src/systems/burn/burnAim.ts
  - src/systems/burn/ignitePerformer.ts
  - src/systems/burn/igniteStance.ts
  - src/systems/burn/burnPersistence.ts
  - src/systems/burn/burnLights.ts
  - src/rendering/burn/burnShade.glsl
  - src/rendering/burn/BurnFilters.ts
  - src/rendering/burn/BurnRenderer.ts
  - src/systems/vfx/vfxPlateBurn.ts
  - src/dev/runtimeBurnSync.ts
triggers:
  paths:
    - "src/systems/burn/**"
    - "src/rendering/burn/**"
    - "src/data/burnables.ts"
    - "src/systems/vfx/vfxPlateBurn.ts"
    - "src/dev/runtimeBurnSync.ts"
    - "src/dev/runtimeBurnApiPlugin.ts"
    - "src/ui/debugBurnSection.ts"
    - "public/assets/data/burnables/**"
    - "tools/editor/shared/burnables.py"
  topics: [燃烧, 可燃物, 可燃物模板, 可燃实例, 可燃挂件, 点火, 引火, 烧纸, 点香, 点蜡烛, 着火点, 握点, 蔓延, 纸钱引燃, 火焰段, burn 条件叶, igniteBurnable, burnable]
  tasks: [做可燃物, 让实体能烧, 让挂件能烧, 让玩家点火, 让火蔓延, 调燃烧表现, 燃烧存档问题, 动态生成可燃物]
verified_by:
  - src/systems/burn/burnSim.test.ts
  - src/systems/burn/BurnSystem.test.ts
  - src/systems/burn/ignitePerformer.test.ts
  - src/systems/burn/igniteStance.test.ts
  - src/systems/vfx/vfxPlateBurn.test.ts
  - src/dev/runtimeBurnSync.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

玩法口径 `docs/玩法功能需求清单.md` A3.8(制作人 09-16 定为"模板 + 实例",取代"可燃物就是热点 + 布置库"——那版把可燃物和场景绑死了)。

- **模板** `assets/data/burnables/<id>.json`(id == 文件名):图、**真实尺寸** `widthCm/heightCm`、握点、燃料、着火点、烧法、粒子、火光;
  和场景无关,唯一写入者是燃烧工作台([[burn-workbench]])。单位全是真实单位(cm、cm/s、秒、m/s),1 m = 88 wu。
- **宿主写 `burnable: {template, initial?, playerIgnite?, igniteConditions?, signals?}`** = 实例化一次:热点 / NPC(场景 JSON)、
  演出生成物(`playTrajectory.spawn.burnable`)、挂件预设(手上的可燃挂件)。**宿主自己的图 / 动画一律失效**,按模板真实尺寸画,
  宿主的位置 / 缩放 / 旋转 / 朝向照乘。`playerIgnite / igniteConditions` 只对场景实体生效。
- **粒子薄片**绑 `plate.burnable: {template}`(只认面燃烧模板;贴图与大小仍归粒子)。

## 权威源(读代码从哪进)

数据形状与缺省 `burnables.ts`(**字段语义以注释为准**;Python 闸门 `tools/editor/shared/burnables.py` 同口径)→ 纯模拟 `burnSim.ts`
(零 Pixi、不读挂钟)→ 几何 `burnGeometry.ts`(实例图 = 一个仿射 + 9×9 世界映射网格)→ 系统 `BurnSystem.ts`(记录 / 对账 / 挪位 /
手上挂件 / 离场照推 / 存读档 / 表现 / 条件叶 / 动作)→ 点火 `burnAim` / `ignitePerformer` / `igniteStance` → 表现 `burnShade.wgsl`(工作台用的 `burnShade.glsl` 是孪生,两份一起改,`src/rendering/shaderTwins.test.ts` 守门)
(唯一 GLSL 源)/ `BurnRenderer` / `burnLights`。组装层接线在 `Game.ts`(实体 / 挂件宿主、`attachSocketView`)。

## 硬契约(违反即 bug)

- **确定性**:事件时刻只由"上一个事件时刻 + 距离 / 速度 + 风在那一刻的解析值"决定;固定步长的量落在**全局** k·h 网格上。
  逐帧活跑 == 一次跑到头 == 离场照推。**模拟里不许读 `performance.now` / 帧 dt。** 同刻外部事件先于内部事件。
- **三层**:记录进档(外部事件日志 + 模板指纹 + 世界映射表 + 风钟分段 + 纸钱烧没的槽位);模拟是记录重放出的缓存、不进档,离场照推,
  所以条件叶与信号始终是当前值;表现只做当前场景和手上的。派生事件永不进日志,**日志只增不删**(复原也不截)。
- **挪位 / 出现 / 收掉是外部事件**:在场宿主每帧按此刻摆放算世界映射,与**日志里此刻该在的那份**比(不是模拟推到一半的位置),
  差 > 0.5 wu 才算挪;整场没有过去就直接换映射不记事件。宿主消失留成幽灵(别人重放要用)。表现用宿主此刻的映射,不等挪位事件。
- **推不出来 ⇒ 整场收束**:模板指纹变了且有过去、场景风定义变了而有外部事件、有过去的实例连模板都建不出来、离场重建缺映射而火还在走——
  整场有过去的切**烧完**,此刻没点的清成干净。宿主挪了 / 生成 / 收掉**不算**推不出来。
- **当前场景世界映射补齐之前不推**(钟照走,齐了按时刻追上;最多等 2 s);onEnter 期间模板还在路上时来的动作排队、按下发时刻记。
- **手上的可燃挂件**(key = `人|挂点`)单独一份模拟、存**快照**;来源次序:暂存(切场景整批卸下 / 读档)→ 包里那根 → 新的一根。
  收起来 = 熄灭 + 记成包里那根;不与场景实例互相碰着(只走按 E),但燃着就算手上有火(点火表演、火焰段点纸钱、引火)。
  与火把那一整套互斥,见 [[held-prop-system]]。
- **燃烧读作者那份场景风**(不含阵风与 F2 倍率),挂件读运行时那份——见 [[scene-wind]] 三份读法。
- **火光**:动态灯来源 `burn`(合并次序与上限见 [[held-prop-lights]]),≤ 6 盏、≤ 20 Hz + 低通、物理闪烁;只在真 3D 场上发,灯位是 M-world。
- **表现两种接法**:热点 = 展示图滤镜链(相机 uniform 在相机定稿后推,推早了烧痕滑一帧);NPC / 挂件 = 图像空间画颜色图 + 自发光
  (**渲染纹理与模板图同尺寸**,否则支点 / 起火点 / 站位全变)。都只在"烧过"时挂。
- **点火表演**:目标是实体 id;站位 = 着火点 − 接触帧火头偏移,闭式不动点迭代(不是 IK);朝着火点那侧优先,都站不了原地点并 dev 告警。
  接触帧那一刻复核"手上还燃着、还能点"才点;被抢状态 / 切场景 / 读档就收手不点。火源:火把优先,其次燃着的可燃挂件;引火不耗火种。
  同一个 E 两个方向(`IgnitePerformer.modeFor`):手上有火且它能点 ⇒ 点它(优先);否则手上没火而它正烧着 ⇒ **引火**(不看"玩家能点 / 能点的条件")。
  火把碰到可燃物、可燃物的火碰到灭着的火把都**不**自动点——防误烧剧情道具,只走 E(场景实例被碰着点只经燃着的纸钱)。
  着火点摆在靠玩家那侧的下沿;没定义着火点 = 火头伸到燃料重心、整体点燃。
- **不写 flag**:状态变化发宿主块里配的叙事信号 + `burn:changed`。条件叶 `{burn, burnSocket?, burnScene?, burnState}`;
  动作 `igniteBurnable / extinguishBurnable / resetBurnable` 改存档、不进过场白名单。
- **与粒子系统的接口**:火苗 / 余烬 / 飞灰走发射形状 `external`——出生点由燃烧系统每帧经 `VfxSystem.setInstanceSpawnPoints` 给(明火格),
  没给点就不发、发射率照常消耗;燃着的纸钱经 `burningPlates()` 反馈,碰到场景可燃物即记一条外部点火事件(带冷却)。火焰段总线见 [[vfx-system]]。
- **雷劈能点着**(模板 `lightningIgnites`,缺省否;09-24 制作人选「只点允许雷点的」):落雷落点竖直往上一段胶囊里、
  开了这一项的当场着(不等引燃延迟),走 `BurnSystem.igniteByLightning` 记外部点火事件(进存档)。场景实例还过玩家手点那道门
  (`playerIgnite: false` 留给脚本点的、能点的条件没满足的不点);手上的挂件、纸钱薄片(`VfxSystem.igniteByLightning`)同样按模板开关。
  **开关不进模板指纹**:它只决定以后雷来了点不点、不改怎么烧,开关它不许让存档里的记录收束。燃烧工作台时长一节有勾选框。
  调用方只有落雷(`Game.boltImpact`,半径来自效果 `bolts[].impact.igniteRadiusWu`),见 [[strike-threat]]。
- **纸钱**:参数全取绑定的模板;从被火碰到的那边烧过去;不跑燃料网格。收模拟那一刻还在烧的按烧没了上报(离场 / 读档 / 改布置),
  存档那一刻在烧的也按烧没了写;`save:restoring` 期间不收上报。

## 存档形状(v2)

`{v: 2, clock, scenes: {sid: {visits, wind, items, plates}}, held: {"人|挂点": 快照}, pocket: {挂件id: 快照}}`;v1(布置库时代)整桶不认。
燃烧钟 `clock` 只在世界不暂停时走,与演出钟是两个钟。

## 已知坑

| 坑 | 症状 |
|---|---|
| 改场景 `wind` 块任何字段(哪怕只是草木增益) | 风指纹是整块 JSON:有外部事件的场景读档时整场切烧完 |
| 模板读不到 | 在场宿主失去可燃性,只打一行 log |
| 火光 `intensityPerM2` 不是正数 | 整块火光丢弃,火照烧、只是不亮 |
| 跨场景的 burn 条件叶第一拍一定是假 | 那个场景没装过时先回 null、后台装好再发 `burn:changed` 叫醒 |
| 面燃烧蔓延期间火光基本不闪 | 闪烁器按直径缓存,而直径每帧随明火面积变 ⇒ 每帧重建、湍流状态清零(代码缺陷,未修) |
| 粒子系统自愈重建后火苗丢失 | 燃烧不检查 `moveInstanceAnchor` 的返回值,重建散掉的临时火苗实例在槽位重开前不会补回(推断,未真跑复现) |
| 纸钱"烧没了"按 实例 → 发射器序号 → 槽位 记,没有效果指纹 | 作者改了发射器顺序 / `spawn.max` / `countScale` 后旧档会静默收错纸 |
| 读档后从没进过的离场场景 | 没有世界映射的实例在进场前点不着、也不被蔓延到 |
| 一路走着的可燃 NPC | 场景有过去后每 0.1 s 记一条挪位,存档随走动变长 |

## 怎么验证

- `npx vitest run src/systems/burn src/dev/runtimeBurnSync.test.ts src/systems/vfx`。
- 真跑 `?mode=dev&devScene=test_room_a`(样例热点 `burn_demo_*`、NPC `burn_demo_figure`、挂件预设 `burn_demo_xiang`):
  挂上 `__game.attachToSocketFromAction('player','right_hand',[],{prop:'burn_demo_xiang'})`,点 `__game.burnSystem.igniteBurnable(...)`,
  表演 `__game.ignitePerformer.start('burn_demo_candle')`;读档用 `saveManager.capturePayload()` + `loadPayload()`
  (**别用 `save(slot)`,那是玩家的存档槽**);`burnSystem.debugSnapshot()` 看状态。
  场景加载完(`Exploring`)之前别操作;Browser pane 与子代理共用,调用带 `tabId`。
