---
id: vfx-system
title: 世界空间粒子 / 群体系统(效果资产 · 布置 · 实例生命周期 · 确定性模拟)
domain: runtime
type: mechanism
summary: 一套粒子系统,群体只是挂了行为模块的发射器;模拟只在 M-world/wu、定步长、带种子逐位可复现;三件正交的东西(全局效果资产 / 按场景×时段外观分份的布置库 / 运行时刺激场),效果与布置唯一写者是粒子工作台;表演态不入档;平面近似下几何判据全空成立、载荷到了靠自愈整场重建;墙是薄壳;发射器行为由 simulation 显式选择(旧资产按固定映射解释);临时实例的种子、一次性实例的收尸、自愈重建会散掉临时实例是三个常踩的坑。着色/分桶/首帧代价见 vfx-rendering,光柱见 vfx-beams,薄片与区域见 vfx-plates-and-areas
status: active
authority:
  - src/data/types.ts#VfxEffectDef
  - src/data/types.ts#VfxPlacementLibrary
  - src/systems/vfx/vfxSim.ts
  - src/systems/vfx/vfxSpace.ts
  - src/systems/vfx/VfxSystem.ts
  - src/systems/vfx/vfxProgram.ts
  - src/data/vfxSimulationContract.json
  - src/systems/vfx/vfxRandom.ts
  - src/utils/depthShellField.ts
  - src/utils/groundHeightfield.ts
  - src/core/ActionRegistry.ts#playVfx
  - tools/editor/shared/vfx_placements.py
triggers:
  paths:
    - "src/systems/vfx/**"
    - "src/utils/depthShellField.ts"
    - "src/utils/groundHeightfield.ts"
    - "public/assets/data/vfx/**"
    - "public/assets/data/vfx_placements.json"
    - "tools/editor/shared/vfx_placements.py"
    - "src/data/vfxSimulationContract.json"
  topics: [粒子, 群体, 蝙蝠, 鸟群, 虫, boids, 刺激场, 烟, 滴水, 萤火, 尘埃, vfx, 发射器, 深度壳, 布置, 布置库, 时段外观, 白天夜里, 预热, prewarm, 起播错峰, 一次性效果, oneShot, 临时实例, playVfx, simulation, 火焰段]
  tasks: [加粒子效果, 改群体行为, 摆效果实例, 布置粒子, 调夜里的粒子, 加刺激源, 查粒子不动, 让剧情粒子可复现]
verified_by:
  - src/systems/vfx/vfxSim.test.ts
  - src/utils/vfxGeometry.test.ts
  - src/systems/vfx/VfxSystem.placements.test.ts
  - src/systems/vfx/VfxSystem.transientReap.test.ts
  - src/systems/vfx/VfxSystem.inputs.test.ts
  - src/systems/vfx/VfxSystem.survival.test.ts
  - src/systems/vfx/vfxTiming.test.ts
  - src/systems/vfx/VfxSystem.prewarm.test.ts
  - src/systems/vfx/vfxPipeline.test.ts
  - tools/editor/tests/test_vfx_action_registration.py
last_governed: 2026-09-23
---

## 是什么(一句话)

效果 = 若干发射器,每个发射器挂模块(外观 / 发射 / 运动 / 寿命 / 碰撞 / **群体行为** / 薄片 / 声音)。
崖墓的蝙蝠群 = 挂了群体行为模块的发射器,滴水 / 香火烟 / 萤火 / 尘埃 / 纸钱是同一套东西。
**一切在 M-world 里算,单位 wu**。作者面是粒子工作台([[vfx-workbench]]);玩法口径在
`docs/玩法功能需求清单.md` A3.6。拆出去的正交部分:着色 / 前后分桶 / 首帧代价 [[vfx-rendering]]、
光柱 [[vfx-beams]]、薄片(纸钱)与粒子区域 [[vfx-plates-and-areas]]。

## 三件正交的东西(改任何一件不牵动另外两件)

| 东西 | 住哪 | 谁写 |
|---|---|---|
| 效果资产 `VfxEffectDef` | `assets/data/vfx/<id>.json`,`id == 文件名`,**不绑场景、不绑时段** | 只有粒子工作台;主编辑器只读 |
| 布置 `VfxInstanceDef` | 布置库 `vfx_placements.json`:场景 → `base` / `variants[时段]` → 实例表 | 只有粒子工作台;主编辑器只读 |
| 刺激场 `VfxFieldDef` | 运行时事件,不落盘 | 谁都能发:`emitVfxField` / 玩家动静 / 场景灯 / 脚步 / 挂件效果块 |

群体按**作者标签**查 `attitude.fear/attract` 权重——不认识的标签权重 0 = 等于没发,且不报错。
加新刺激不改物种;但**新 tag 必须给认它的物种配权重**,否则场放了等于没放。
场景 JSON 里再出现 `vfx` 键 = 校验器 error(09-14 迁出,运行时不读)。

## 硬契约(违反即 bug)

- **模拟只在 M-world、单位 wu**(铁律 0 同一条);画面点 ↔ 3D 只经 `utils/sceneSpace.ts` 一份实现。
- **确定性**:定步长 1/120 s、只吃调用方给的 `dt`,绝不读挂钟、不许 `Math.random`;同一份效果 + 同一个种子 +
  同一串 dt ⇒ 逐位相同。发射器有独立的**节拍流**,开 `spawn.intervalJitter` 不扰动位置 / 寿命的随机序列;
  局部湍流 / 游走用**模拟自己的钟**,场景风用风钟(不许让场景钟混进局部噪声,否则固定种子重播也对不上)。
- **起播错峰是可选能力**:效果 `prewarmSeconds [min,max]`(≤ 15 s)按种子取样静默预热;时间锚在第一次推进时定,
  分几片跑与一口气跑逐位相同。预热期间不施加玩家 / 刺激 / 接触、不补播事件、不画、不上报燃着的纸。缺省不预热——
  别给所有效果开,演出从中途开始不是缺省行为。
- **表演态,不入档。** `serialize` 恒空桶;`scene:beforeUnload` / 读档 = 世代号 +1、全部实例散掉。
- **发射器的行为由 `simulation` 显式选择**(求解器 / 出生 / 初速 / 影响开关 / 补回):写了就走
  `vfxSimulationContract.json` 的公共契约,TS 与 Python 共用 `emitterProgramErrors`,非法组合不许静默落空;
  **没写的旧资产按 `resolveEmitterProgram` 的固定映射解释,绝不回写升级**。参数块在 ≠ 启用:例如旧薄片的
  `motion.stimulus` 实际不生效,要显式写 `simulation` 才打开。
- **接触冲量与空气速度是两路输入**:脚 / 身体扫过是运动学接触(`vfxContact`,按子步切片防隧穿),不是往空气里加风。
- **🔴 平面近似下一切几何判据"空成立"**:没有照明载荷时退到 `[x, 0, −y·k]`,地面恒 0、没有墙,零报错。
  载荷异步到达,所以 `update` 里有一条便宜的自愈检查,真 3D 场一可用就**整场重建**——删掉它 = 大部分场景粒子永远跑在虚空。
  时段变体没自己的载荷、且没换深度图时,运行时借主背景的**几何项**(粒子照样真 3D;光照项不借,见 vfx-rendering)。
- **🔴 模拟侧的壳是薄壳**(`thinShellSide`,壳厚 `SHELL_THICKNESS_WU`):可见面后一个壳厚内算撞上,更深处是遮挡物背后的空处,
  由渲染的深度遮挡藏掉;每粒一个滞回位 `p.behind`。通用碰撞 / 群体避墙 / 群体不进壳 / 薄片接触四处同一条判据。
  旧判据"面后全实心"让粒子永远到不了会被挡住的位置(09-12 实测约 1000 颗里 0 颗),别退回。
- **群体**:整群一个状态机(roosting → airborne → fleeing → returning),逐只只有 boids 三力 + 轨道 + 避墙 + 刺激 + 反应延迟。
  三力写成**加速度上限 × 方向**(wu/s²),不许无量纲权重魔数。巢整团推到壳外(否则一半埋在石头里永远看不见)。
  `onHit` 子发射器不许指自己、不许同时 `subOnly` 与群体(校验器拦)。
- **普通粒子默认只认 `wind` 场**;要被人惊开写 `motion.stimulus {fear/attract: {tag: 权重}, accel}`(真加速度)。
  与 `behavior` 同时写时只走 `attitude`、构建期 warning。
- **布置取份 = 时段外观**:`appearancePhaseFor(当前时段)`,与背景 / 光照换装同一判据;**没配就没有、互不继承**
  (制作人 09-13)。时段推进按 id 差分换表,定义逐字没变的实例原样留着;临时实例不归布置表管。
  ⚠ 不能只靠换装重载判(两外观等价时不重载,但布置可以不同)。`playVfx {instanceId}` / `vfx` 条件叶找的是**当前在场**那条。
- **条件**在 flag / narrative / 时段 / 任务事件时标脏,另有 0.5 s 兜底重评;`vfxState` 叶没有唤醒事件,叙事图 reactive 条件里不许用。
- **停的四种语义**:`stopVfx` 对临时实例当场删、对布置实例停发射;软停 = 不再发、在飞的飞完再删;`fadeMs` = 整实例淡出
  (软停打断不了);`oneShot` = `sim.finished`(不会再发 + 一颗活的都没有 + 光柱全暗)时自收。
  兜底只收"停了且没模拟"的临时实例——还在装的、建不出来但没停的**故意不收**(工作台修好效果后靠它们恢复)。
- **实例倍率**(运行时 API,手持火把 / 燃烧逐帧推):发射率(允许 0)/ 新生大小(只乘新生)/ 吃风 / 火焰距离。
  **存在实例上**,自愈重建时重新套上。`motion.followAnchor`:`none` 留在空气里 / `rig` 只带宿主动画位移(火舌拖尾)/ `full` 整个跟;
  `life.maxDistance` 让离发射原点越远越早走完寿命曲线。`playVfx followCamera`(天气类临时实例)只挪发射原点,已发出的留在世界坐标。
- **火焰段总线**:`setFireSources(owner, segs)` 按来源整份替换(空数组 = 删该来源);`heldProp`(燃着的火头)、`burn`(可燃物明火块)
  + 各模拟本帧开头燃着的纸拼成 `ctx.fires`(一帧延迟)。燃烧侧的接口(`external` 出生形状、可燃薄片、`burningPlates`)见 [[burn-system]]。
- **命名句柄** `handle` 重名 = 替换旧实例、不复用真实 id;旧账本只停自己记下的 id。
- **现画的雷**(09-24):效果顶层 `bolts[]`(形状参数,`kind: sky | surface`)+ 发射器 `appearance.bolt` 引用它画(一层主干 + 分叉、
  一层只加亮主干);形状 `vfxBolt.ts`、画法 `vfxBoltWgsl.ts`(游戏)/ `vfxBoltGlsl.ts`(页内工作台预览)两份孪生,一起改,`src/rendering/shaderTwins.test.ts` 守门。雷是**世界单位**,细节按屏幕像素挑细分级,
  粗细 = 世界宽与屏幕下限合成。见 [[strike-threat]]。
- **落点表面**:布置库 `scenes[场景].surfaces`(水面 / 湿地,场景级)→ `surfaceKindAt`(盖着这一点的**最后一块**区是水面 = `water`,
  与反光遮罩同一次序)→ 实例建模拟时定 `surfaceKind`,发射器 `onSurface: [ground | water]` 按它开关(落在水上换水花与水面电弧)。
  预览布置库带 `surfaces` 时换那一份;改区经 `onSurfacesChanged` 通知场景光照重画反光遮罩。
- **`playVfx({ onStart })`**:模拟第一次建起来那一刻回调一次(效果、种子、世界锚点、落点表面);落雷的灯、冲击风、点火都挂在这一拍。
- **冲击风**经 `getWind().blasts / blastTime` 进一般粒子与薄片,见 [[scene-wind]];**雷点纸钱**:`igniteByLightning` 只点绑的模板开了开关的,见 [[burn-system]]。

## 已知坑(都不报错)

| 坑 | 症状 / 对策 |
|---|---|
| **没写 `seed` 的 `playVfx` 不可复现** | 临时实例 id 带**会话级**递增序号、种子 = `hashSeed(id)`,序号跨场景不清零 ⇒ 同一段剧情在不同会话里随机序列不同。要复现就写 `seed` |
| **自愈重建会散掉全部临时实例** | 挂件看 `moveVfx` 返回 false 会重开;燃烧的火苗实例目前不看返回值、重建后丢失直到槽位重开(见 burn-system) |
| **一次性效果永远不 finished** | 效果装不到 / 建不出模拟(兜底不收)、含一直发的发射器、或带光柱(光柱没有寿命,不 stop 就不暗)。挂件等 oneShot 放完才卸燃尽的火把 ⇒ 会卡在手上。带光柱的一次性效果要显式软停,且光柱 `fadeOut` 短于最后一颗粒子寿命(软停收尸看 `liveCount`,不看光柱) |
| `playVfx` 对不存在的效果也立刻返回实例 id | 装不到只打 log,调用方从返回值看不出失败 |
| 粒子事件音 / 循环音绕过音频解算器 | 直接拿粒子的 M-world 发声(`playSfxAt` dep):配了透视线的场景里与听者不在同一空间,粒子空间不存在时直接不响。见 [[audio-listener-space]] |
| 一帧超过 12 子步丢弃余量 | 卡顿帧让模拟时间落后风钟;确定性只对"同一串 dt"成立。`stats.simMs` 取稳态中位 |
| 惊起半径是**三维**距离 | 巢在崖上 338 wu,半径 260 走到正下方也惊不动 |
| 活动域半径 ≥ 场景尺寸 | 玩家永远在域内,群跟着人满场飞 |
| 恐惧攒 / 衰平衡卡在阈值上 | 稳态恐惧 = 场强 / 衰减率,与阈值差一线时惊散时有时无 |
| 刺激场按直线距离 `(1−r/R)²` 衰减 | `r=0.9R` 只剩 1%;举火把 127 wu 外恐惧只到 0.086,不惊散。驱群靠挂件效果块的场(`torch:fire` 等),不是灯光 |
| `surface:'shell'` 锚点 `h=0` | 生在壳面上,第一子步判撞壳打死 |
| 挑檐口不查 `groundObserved` | 画面顶端行走面是外推的,算出九个人高的假檐 |
| 验"举火把 / 惊散"时玩家瞬移 | 动静场强度按速度算,站着 / 瞬移恒 0 |

代价参考(09-11):普通粒子 ≈ 1.9 µs/只,群体 ≈ 6.4 µs/只(贵在固定开销,不在邻居扫描)。预算线:普通 ≤ 300 只 / 场景,
群体 ≤ 200 只、稳态 < 1.5 ms/帧。

## 怎么验证

- `npx vitest run src/systems/vfx src/utils/vfxGeometry.test.ts`(确定性 / 薄壳 / 群体状态机 / 布置取份与差分 / 收尸 / 预热分片)。
- 构建期:`./dev.sh validate-data`(效果结构、布置库、场景残留 `vfx`、四条 vfx 动作、`vfx` 条件叶)。
- 真机:`?mode=dev&devScene=<场景>`,读 `window.__game.vfxSystem`(`debugSnapshot()` / `stats` / `currentSpace`),
  **先确认 `currentSpace.kind === 'field'`**,否则几何判据全空;驱动见 [runtime-command-channel](../recipes/runtime-command-channel.md)。
  判"被挡"看 `sim.emitters[i].p.behind`,别拿"有没有粒子被挡"判(开阔处 0 颗是对的)。
