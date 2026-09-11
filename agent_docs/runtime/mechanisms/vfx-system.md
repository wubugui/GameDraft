---
id: vfx-system
title: 世界空间粒子 / 群体系统(效果资产 · 场景实例 · 刺激场)
domain: runtime
type: mechanism
summary: 一套粒子系统,群体(蝙蝠群)只是挂了行为模块的发射器;模拟只在 M-world/wu、地面走高度场、墙走深度壳 CPU 副本;三件正交的东西(全局效果资产 / 场景实例 / 运行时刺激场);表演态不入档;渲染一批一张网格、按接地锚在实体之间分桶
status: active
authority:
  - src/data/types.ts#VfxEffectDef
  - src/systems/vfx/vfxSim.ts
  - src/systems/vfx/vfxSpace.ts
  - src/systems/vfx/VfxSystem.ts
  - src/rendering/vfx/VfxRenderer.ts
  - src/rendering/vfx/vfxShaders.ts
  - src/utils/depthShellField.ts
  - src/utils/groundHeightfield.ts
  - src/core/ActionRegistry.ts#playVfx
triggers:
  paths:
    - "src/systems/vfx/**"
    - "src/rendering/vfx/**"
    - "src/utils/depthShellField.ts"
    - "src/utils/groundHeightfield.ts"
    - "public/assets/data/vfx/**"
  topics: [粒子, 群体, 蝙蝠, 鸟群, 虫, boids, 刺激场, 烟, 滴水, 萤火, 尘埃, vfx, 发射器, 深度壳]
  tasks: [加粒子效果, 改群体行为, 摆效果实例, 加刺激源, 改粒子渲染]
verified_by:
  - src/systems/vfx/vfxSim.test.ts
  - src/rendering/vfx/VfxRenderer.test.ts
  - src/utils/vfxGeometry.test.ts
  - tools/editor/tests/test_vfx_action_registration.py
last_governed: 2026-09-11
---

## 是什么(一句话)

**一套粒子系统,群体只是它的一种应用**:效果 = 若干发射器,每个发射器挂模块
(外观 / 发射 / 运动 / 寿命 / 碰撞 / **群体行为** / 声音);崖墓的蝙蝠群 = 挂了群体行为模块的
发射器,滴水 / 香火烟 / 萤火 / 尘埃只是没挂它的同一套东西。
**一切在 3D 伪世界(M-world)里算**,单位 wu —— 粒子不入地、不穿崖壁,飞到关二狗身前身后
按真实纵深排序,吃 probe 底光与场景实体灯。

作者面(粒子工作台)见 [[vfx-workbench]];玩法侧的设计口径在
`docs/玩法功能需求清单.md` 的 A3.6。

## 三件正交的东西(改任何一件不牵动另外两件)

| 东西 | 住哪 | 谁写 |
|---|---|---|
| **效果资产** `VfxEffectDef` | `public/assets/data/vfx/<id>.json`,`id == 文件名` | **只有粒子工作台**;主编辑器只读镜像(与 `trajectories/` 同一待遇:无脏桶、不进 save_all、不进外部改动基线) |
| **场景实例** `VfxInstanceDef` | 场景 JSON `vfx[]`(效果 id + 锚点 + 条件 + 时段 + 种子 + 数量倍率) | 主编辑器场景页 |
| **刺激场** `VfxFieldDef` | 运行时事件,**不落盘** | 谁都能发:`emitVfxField` 动作 / 玩家动静 / 场景灯 / 脚步 |

**换物种不改场景、加刺激源不改物种、换场景只改实例。** 群体按**作者标签**查自己的
`attitude.fear/attract` 权重 —— 不认识的标签权重 0 = 等于没发,所以加一种新刺激不用动任何物种。

## 权威源(读代码从哪进)

形状在 `types.ts` 的 VFX 一节(**字段清单与缺省以那里为准**);模拟数学在 `vfxSim.ts`
(纯函数、零 Pixi、零挂钟);空间抽象在 `vfxSpace.ts`;几何底座在 `utils/depthShellField.ts`
与 `utils/groundHeightfield.ts`(跨语言金标 `vfxGeometry.golden.json`,真相源是轨迹工作台的
`geometry.py`);生命周期 / 资产装载 / 刺激总线在 `VfxSystem.ts`;画法在 `rendering/vfx/`;
动作在 `ActionRegistry` 的 `playVfx` / `stopVfx` / `setVfxState` / `emitVfxField`。

## 硬契约(违反即 bug)

- **模拟只在 M-world、单位 wu**(铁律 0 同一条)。位置 / 速度 / 加速度 / 半径全是 wu 系:
  角色高 150 wu、1 m ≈ 88 wu、g ≈ 865 wu/s²。画面点 ↔ 3D 只经 `utils/sceneSpace.ts`
  那**一份**实现(与摆灯、空间音同源),不许再写第二份换算。
- **定步长 1/120 s + 只吃调用方传进来的 `dt`**,绝不读挂钟。同一份效果 + 同一个种子 +
  同一串 dt ⇒ 逐位相同(无头验证逐帧断言靠它)。一帧最多 12 个子步,超了丢弃余量 ——
  隐藏页 / 掉帧时不许"补跑"一大段。
- **表演态,不入档。** `serialize` 恒空桶;`scene:beforeUnload` 整批散;读档 = 换时间线同样作废。
- **🔴 平面近似下一切几何判据都是"空成立"。** 没有照明载荷的场景退到
  `[x, 0, −y·√2]` 的平面近似:`groundY` 恒 0、`shellContact` 恒 null ——
  "没入地""没进壳"全部假过,而且**不报任何错**。
  ⚠ 而照明载荷是**异步到达**的,`scene:ready` 那一刻常常还没落地,实例只好先建在平面上。
  所以 `VfxSystem.update` 里有一条**便宜的自愈检查**(`deps.hasFieldGeometry()` 只读几个 getter、
  不建高度场):一旦真 3D 场可用就整批重建。删掉它 = 大部分场景里粒子永远跑在虚空中。
  判断某次验证有没有意义,先看 F2「粒子」页那一行说的是"真 3D 场"还是"平面近似"。
  ⚠ **时段变体现在整体没有载荷**:2026-09-11 实测,崖墓入口、崖墓前段换到「夜」以后
  `currentSpace.kind` 都退成 `planar`(载荷是按背景基名烘的,只有主背景那一份)。
  所以"夜里那一套粒子"的地面 / 壳判据一律作废——不受光、飘在空中的(萤火虫)无所谓,
  要落地、要贴墙、要撞壳的(滴水、蝙蝠栖息)在夜场景里就是错的,别拿夜场景当验收现场。
- **群体的巢要整团推到壳外。** 崖壁上的巢以原点为心取随机球,**有一半埋在石头里**
  (实测崖墓前段 60 只里 11 只),那些个体被遮挡、永远看不见。`populateFlock` 按壳法线
  把整团推出一个巢半径,随机球缩到 0.75 倍。
- **`onHit` 的子发射器不许指向自己**(撞一次发一批、发出来再撞 = 自激),也不许同时是
  `subOnly` 与群体(子发射器由撞击现场生成,没有巢也没有状态机)。校验器两条都拦。
- **三力写成"加速度上限 × 方向",没有无量纲权重。** 分离 / 对齐 / 凝聚各自一个
  `wu/s²` 上限,作者面填的是真加速度。不许出现"weight 0.37 调出来好看"这种魔数
  (见 [physical-derivation-over-fitting](../decisions/2026-08-23-physical-derivation-over-fitting.md))。
- **受光必须吃场景那次 `packLights`**,不许粒子侧再打一遍(第二个真相源,且不报错);
  显示变换与背景同一组参数(`applyDisplay`),少这一条就是"背景很亮、粒子漆黑"。
  probe 查表传 `nQ = Rᵀ·n`、灯循环用世界法线 —— 与角色同口径,别翻案
  (见 [character-lighting](character-lighting.md))。
- **受光那条路只有漫反射,没有镜面、没有散射相函数。** 所以"靠高光才看得见"的材质
  (水滴、火星)和"靠强前向散射才看得见"的材质(尘埃、雾)用纯 `lit` 画出来一律是黑疙瘩——
  不是 bug,是模型缺项。两个出口,按材质选,别拿 tint 硬提亮:
  ① `appearance.emissive`(0..1,只对 `lit` 有效)= 这份亮度不吃漫反射着色,代表那条我们
  算不出来的镜面项;水滴走这条(实测崖墓前段:emissive 0 时 23/255、背景 68/255,人眼看不见;
  0.45 时 74/255,读作一道蓝白水痕)。
  ② 整个 `lit:false` + `blend:add` + 作者填的 `tint` —— 光靠一盏点光根本照不亮的环境颗粒
  走这条(实测义庄尘埃改 `lit:true` 后:变化像素 574、均值 3.3、峰值 26,等于没有;
  搬到烛火跟前也只有贴着灯的几粒亮起来)。代价说清楚:这条**不随场景光变化**,和萤火虫同级,
  是作者摆的氛围件。
- **遮挡拿粒子自己的纵深比壳**,不是角色那套"脚深度 + 直立 quad 代理"(粒子**有**真 3D 位置)。
  同一条 `depth_mapping` 解码、同一个 `depth_tolerance`。
- **一批粒子 = 一张网格,不是 N 个 Sprite。** 实体层的排序器与裁剪器每帧遍历每个子节点,
  逐 Sprite 的遮挡还要逐个 RT;几百个 Sprite 进去要吃两遍。
- **长活 shader 的场景纹理槽位与 `createLitShader` 同处维护**(`LIT_SHADER_SCENE_TEXTURE_SLOTS`);
  切场景前粒子系统先销毁自己的 shader,早于纹理销毁 —— 漏一个槽 = 整局卡死
  (见 [pixi-v8-traps](pixi-v8-traps.md))。

## 普通粒子怎么认刺激场（`motion.stimulus`）

群体有整套 `behavior.attitude`（反应延迟、恐惧累积、状态机）。**普通粒子默认只认 `wind` 场**，
`fear` / `attract` 一律穿过去不起作用——这是刻意的：绝大多数粒子（烟、水滴、尘埃）不该被人走过
就吹散。要让它反应，给发射器加 `motion.stimulus`：

```jsonc
"stimulus": { "fear": { "player:motion": 1.0, "sfx:footstep": 0.35 }, "accel": 1600 }
```

方向是「场心 → 粒子」（`attract` 取反），大小 = 权重 × 场强 × `(1−r/R)²` × `accel`，
与群体三力同一口径：**作者填的是真加速度（wu/s²），不是无量纲权重**。

两条不叠加：发射器同时有 `behavior` 和 `motion.stimulus` 时运行时只走 `attitude`，
构建期记 warning（`_validate_vfx_effects`）。

标定参考（萤火虫，2026-09-11 实测）：玩家动静场半径 320 wu、走路时强度 0.24（= 走速 100 / 满强度 420）。
对起手离玩家 < 150 wu 的那批量「被推开多远」：

| `accel` | 推开 | 峰值速度 |
|---|---|---|
| 700 | 14 wu | 55 wu/s |
| **1600** | **74 wu** | 110 wu/s（顶到 `maxSpeed`） |
| 5000 | 84 wu | 148 wu/s |

700 在画面上根本看不出来；1600 是「人走近轻轻让开、站住两秒自己飘回来」。再往上只是更快，
推不远——因为 `drag` 把它拉回去、`maxSpeed` 又封顶。**调这条先确认玩家在「走」**：
动静场强度按速度算，站着不动强度恒 0，瞬移玩家去测一定测不出东西（本会话踩过）。

## 前后关系怎么定(分桶)

实体层的排序只认脚底 y([entitySortRule](../../src/rendering/entitySortRule.ts) 那套)。
粒子的"脚" = 它**正下方地面点**投到画面的 y(与轨迹 `sortY` 同一约定)。
把场上没标静态档位的实体脚点排好序当阈值,粒子按脚 y 落进哪个区间就进哪个桶,
桶网格的 `entitySortFootY` 取该区间上界 ∓ε —— 于是它排在下一个实体后面、上一个实体前面。
桶数 = 实体数 + 1,上限 `MAX_BUCKETS`(超了按分位数合并)。
实测(崖墓前段,玩家脚点 600):放到他身后的个体脚点 416 → 低桶;身前的 784 → 600.001。

## 群体状态机(整群一个,逐只只有 boids)

```
roosting ──玩家进惊起半径 / 有怕的刺激──> airborne(绕玩家或绕巢)
   ↑                                          │ 恐惧均值 > fleeThreshold
   │                                          ↓
returning <──安静 calmSeconds──────────── fleeing
   │  玩家离开活动域 1.5s 后从 airborne 也进得来
   └──逐只飞回自己的挂点、落满即 roosting
```

逐只只有:三力 + 轨道(切向 + 半径修正)+ 避墙(前瞻 0.35 s)+ 高度下限 + 刺激场 +
反应延迟与个性抖动。**没有逐只状态机。**

## 已知坑(都是真跑踩出来的,都不报错)

| 坑 | 症状 |
|---|---|
| **惊起半径小于巢到路面的高差** | 玩家走到巢正下方也惊不动(崖壁上的巢离路面 338 wu,半径 260 够不着)。半径是**三维**距离 |
| **活动域半径 ≥ 场景尺寸** | 玩家永远"在域内",群永远不回巢、跟着人满场飞。活动域必须明显小于场景 |
| **恐惧的攒/衰平衡卡在阈值上** | 稳态恐惧 = 场强 /(每秒衰减比例),与阈值只差一线时惊散判定时有时无。实测衰减 0.6 / 阈值 0.35 → 稳态 0.39,不稳;改成 0.35 / 0.25 → 稳态 0.83 |
| **刺激场半径按"玩家到粒子"直线量,忘了高差** | 场按 `(1−r/R)²` 衰减,`r=0.9R` 时只剩 1%。蝙蝠被崖壁顶开、绕在 470 wu 外,半径 520 的场等于没发(实测恐惧只到 0.13) |
| **`surface:'shell'` 的锚点 `h=0`** | 粒子正好生在壳面上,第一个子步就被判"撞壳"当场打死(滴水一颗都活不过)。要离面一点 |
| **拿"壳高出正下方地面"挑檐口,不判地面有没有观测** | 画面顶端行走面是外推的,clearance 算出 1400 wu(九个人高)的假檐。挑锚点必须先查 `groundObserved` |
| 平面近似当成真 3D 场 | 见上面那条硬契约 |
| **拿纯漫反射画水 / 尘这类材质** | 粒子比背景还黑(水滴 23 vs 背景 68),或者干脆低于人眼阈值(尘埃均值 3.3/255)。像素 A/B 全是"画了",肉眼全是"没有" —— 判据必须同时看变化像素数**和**截图 |
| **粒子飘在相机外还在按"看不见 ⇒ 没画"结论** | 全画面 diff 出 0 不等于渲染坏了:先拿 `mesh.parent.toGlobal()` 确认那一团在不在画布里(实测滴水锚点在场景 x≈493,相机跟着玩家在 x≈1046,全局 x 算出 −704) |

## 代价（2026-09-11 实测）

**群体粒子比普通粒子贵一个量级**，按只数拍预算会拍错：

| 场景 | 只数 | 模拟（稳态中位） | 单只 |
|---|---|---|---|
| 义庄（香火烟 98 + 尘埃 112，都是普通粒子） | 215 | **0.4 ms/帧**（p95 0.5、峰 0.7） | ≈ 1.9 µs |
| 崖墓前段（蝙蝠 180，群体 + 滴水 12） | 192 | **1.2 ms/帧**（p95 1.7） | ≈ 6.4 µs |

差在群体那条路：三力邻居扫描 + 轨道 + 避墙前瞻 + 刺激累积，普通粒子一条都不走。
实测把 `senseRadius` 从 170 压到 120 只省 0.1 ms —— **贵在每只的固定开销，不在邻居扫描**，
想省就只能减只数。渲染侧写顶点缓冲 0.09 ms/帧；draw call = 效果数 × 深度桶（实测 2–6）。

⚠ 读 `stats.simMs` 要取**稳态中位**：掉帧后那一拍会补跑多个子步（上限 12），单帧读数能到几十 ms，
拿它当稳态会误判成"超预算"。预算线:普通粒子每场景 ≤ 300 只；群体每场景 ≤ 200 只、稳态 < 1.5 ms/帧；
draw call ≤ 8。

## 怎么验证

- 单元:`vfxSim.test.ts`(确定性 / 不入地 / 不进壳 / 惊起 → 惊散 → 回巢 / 子发射 / 大 dt 封顶)、
  `VfxRenderer.test.ts`(曲线 + 分桶)、`vfxGeometry.test.ts`(与 `geometry.py` 的跨语言金标)。
- 构建期:`./dev.sh validate-data`(效果资产结构、场景实例、四条 action 的参数、`vfx` 条件叶);
  `asset_reference_audit --strict` 管贴图存在性。
- 真机:`?mode=dev&devScene=<场景>`,页内直读 `window.__game.vfxSystem`
  (`debugSnapshot()` / `stats` / `currentSpace`),按
  [runtime-command-channel](../recipes/runtime-command-channel.md) 驱动;
  **先确认 `currentSpace.kind === 'field'`**,否则所有几何判据都是空的。
  画面取证走 [headless-visual-verification](../recipes/headless-visual-verification.md);
  F2「粒子」页有状态、只数、draw call、模拟毫秒与三个刺激按钮。

## 相关

- 作者面:[[vfx-workbench]]
- 坐标与单位:[[coordinate-spaces]]、[[lighting-scale-reference]]
- 受光同口径:[[character-lighting]]、[[scene-lighting]]
- 遮挡与脚点:[[entity-lighting]]
- 同为"烘焙 / 表演态 + 独立资产 + 独立工作台"的近亲:[[entity-trajectory]]
