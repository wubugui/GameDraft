---
id: vfx-system
title: 世界空间粒子 / 群体系统(效果资产 · 场景实例 · 刺激场)
domain: runtime
type: mechanism
summary: 一套粒子系统,群体(蝙蝠群)只是挂了行为模块的发射器;模拟只在 M-world/wu、地面走高度场、墙走深度壳 CPU 副本且壳是薄壳(遮挡物背后是空处);三件正交的东西(全局效果资产 / 场景实例 / 运行时刺激场);表演态不入档;渲染一批一张网格、按水平纵深在实体之间分桶;着色 lit / tone / unlit 三条路与 NPC 同源
status: active
authority:
  - src/data/types.ts#VfxEffectDef
  - src/systems/vfx/vfxSim.ts
  - src/systems/vfx/vfxConfine.ts
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
  topics: [粒子, 群体, 蝙蝠, 鸟群, 虫, boids, 刺激场, 烟, 滴水, 萤火, 尘埃, vfx, 发射器, 深度壳, 粒子区域, 发射区域, 范围区域, 软边界]
  tasks: [加粒子效果, 改群体行为, 摆效果实例, 加刺激源, 改粒子渲染, 限定粒子范围, 配粒子区域]
verified_by:
  - src/systems/vfx/vfxSim.test.ts
  - src/systems/vfx/vfxConfine.test.ts
  - src/rendering/vfx/VfxRenderer.test.ts
  - src/utils/vfxGeometry.test.ts
  - tools/editor/tests/test_vfx_action_registration.py
last_governed: 2026-09-13
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
  **时段变体没有自己的载荷目录时**(逐场景看:雾津街头有夜目录,崖墓前段 / 跑马梁没有),
  只要变体**没换深度图**,运行时借主背景那份的**几何项**(`CharacterLightingSystem.loadGeometryOnly`,
  "各时段必须共享几何"本来就是校验器的硬规则),粒子照样是真 3D 场;**光照项不借**,
  受光粒子走 tone 路(见下)。2026-09-12 之前夜里整份缺席、退平面近似(那时的实测:崖墓前段 /
  崖墓入口换「夜」后 `currentSpace.kind === 'planar'`)。变体自带 depthConfig 时仍不借、仍退平面。
- **群体的巢要整团推到壳外。** 崖壁上的巢以原点为心取随机球,**有一半埋在石头里**
  (实测崖墓前段 60 只里 11 只),那些个体被遮挡、永远看不见。`populateFlock` 按壳法线
  把整团推出一个巢半径,随机球缩到 0.75 倍。
- **`onHit` 的子发射器不许指向自己**(撞一次发一批、发出来再撞 = 自激),也不许同时是
  `subOnly` 与群体(子发射器由撞击现场生成,没有巢也没有状态机)。校验器两条都拦。
- **三力写成"加速度上限 × 方向",没有无量纲权重。** 分离 / 对齐 / 凝聚各自一个
  `wu/s²` 上限,作者面填的是真加速度。不许出现"weight 0.37 调出来好看"这种魔数
  (见 [physical-derivation-over-fitting](../decisions/2026-08-23-physical-derivation-over-fitting.md))。
- **受光必须吃场景那次 `packLights`**,不许粒子侧再打一遍(第二个真相源,且不报错);
  灯循环本体是角色那段 `ENTITY_SCENE_LIGHTS_GLSL`(`CharacterLitSprite.ts`)原样拼接,
  `worldSpaceShading.test.ts` 钉着"`vfxShaders.ts` 里不许出现 `lc*Light` 调用"。
  显示变换与背景同一组参数(`applyDisplay`),少这一条就是"背景很亮、粒子漆黑"。
  probe 查表传 `nQ = Rᵀ·n`、灯循环用世界法线 —— 与角色同口径,别翻案
  (见 [character-lighting](character-lighting.md))。
- **着色三条路,逐帧校验、条件变了就重建视图**(`VfxRenderer.viewStale`):
  **lit**(有照明载荷)/ **tone**(外观要受光、但本场景 / 时段没载荷——走 NPC 此时的
  `EntityLightingFilter` 色调融入:同一张运行时辐照 probe、同一组 key / ambient / toneStrength、同一个式子)/
  **unlit**(`lit:false`)。三条都过显示变换。视图按"建的那一拍有什么"定 program,载荷晚到、
  着色开关、深度纹理 / 贴图 / 发射器换了都要重建——以前只在建视图时问一次,晚到的载荷一路错到换场景。
- **角色 / 粒子那组实体灯与显示变换,换场景时归零**(`Game` 的 lightingUnloader)。装载器只在场景
  **有** lighting 块时重写它;不清的话下一个没配 lighting 的场景接着用上一个场景的灯与 wuPerQUnit
  (2026-09-12 实测:义庄 → 崖墓前段后仍是义庄那 1 盏烛火、220 wu/q)。
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
- **🔴 模拟侧的壳是薄壳,不是"面后面全实心"**(`vfxSpace.thinShellSide`,`SHELL_THICKNESS_WU = 60`):
  可见面后一个壳厚以内算撞上(按碰撞响应推回,推出量 ≤ 壳厚 + 半径);更深的是**遮挡物背后的空处**,
  模拟不管、渲染的深度遮挡把它藏掉。每粒子一个滞回位 `p.behind`:进了背后,只要仍在当前像素那层面
  之后就一直算背后,回到任何可见面之前才解除(否则横挪到遮挡物边缘时会被从背后一把推到前面)。
  四处消费方同一条判据:通用粒子碰撞、群体避墙前瞻、群体"不进壳"硬约束、薄片接触;
  出生即在背后的(`spawnsBehindShell`)不推。
  **为什么**:旧判据 `penWu > −r` 就推回,粒子永远到不了会被挡住的位置——渲染侧的逐片元遮挡
  从来没机会生效(2026-09-12 实测义庄 / 跑马梁 / 崖墓前段约 1000 颗,处在被挡位置的 0 颗;
  义庄香火烟 38% 贴在壳面上滑)。改后跑马梁风里 60 s 有 5 张纸钱被卷到遮挡物背后、最多 2 张同时被藏。
  角色没有这个问题:它的位置由行走面约束,行走面在遮挡物背后是连续的。
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

## 薄片(纸钱)与场景风

- 挂 `plate` 模块的发射器,每颗粒子是一张有朝向、会弯的薄片,走 `vfxPlate.ts`(平板气动 + 库仑接触 +
  贴附 + 睡眠);`collision` 不读、`motion` 只剩 `turbulence`。渲染是逐顶点投影的条带(`VfxPlateBatchMesh`),
  受光版 program 声明了 `aNrm`,**只能**配条带网格。
- 场景有 `wind` 时,**普通粒子只要 `drag > 0` 就被风带着走**(阻力相对空气);没 `wind` 的场景一字不变;群体不吃风。
- `spawn.shape.kind = 'area'` + 实例 `area` 多边形:逐点落到那一点**看得见的表面**(地面躺、物件上挂、崖下虚空不放),
  只对薄片的 burst 生效。
- 风的模型、透视度量、草木摆动拆层、已知坑:[[scene-wind]]。
- **薄片按毫秒算预算,不按只数**:大部分时间在睡(只做便宜的唤醒检查)。实测跑马梁 520 张:
  模拟 ≈ 0.3 ms + 顶点填充 ≈ 0.4 ms/帧(下面"普通粒子 ≤ 300 只"那条线是按普通粒子单只成本定的)。

## 粒子区域(发射区域 `area` + 范围区域 `confine.area`,软边界)

**两块区域分开配**(制作人 2026-09-13 点名要求):**发射区域** = 实例的 `area`(纸钱铺在哪、被回收的从哪补回);
**范围区域** = `confine.area`(粒子被关在哪),没写就用发射区域。发射区域小、范围区域大 = 纸钱铺在一小片、
被风吹着能飞满一大片。作者面是主编辑器场景页 vfx 那一栏的「拉发射区域」「拉范围区域」
(见 [[vfx-workbench]]「场景页的粒子区域」)。纯函数在 `vfxConfine.ts`,
薄片那一半在 `stepPlates` / `replenishPlate` / `pickAreaSurface`,普通粒子那一半在 `stepGeneric`。
出生 / 补回点先在发射区域里挑、再按**范围区域**的权重拒绝采样——两块不相交时一张都挑不到(校验器 warning)。

- **判据是粒子正下方的地面点**落在画面上的位置,不是粒子自己的画面位置——区域是地上的一块,
  纸在它上空飞是对的(代价:飞得高的纸在画面上会出现在框线上方)。
- 多边形烘成一张**权重网格**(实例建一次;框内深处 1、从框线往里 `feather` 宽的边带里 smoothstep 降到 0、
  框外 0),每子步双线性查一次。**没有推回力、没有硬裁剪**,三件事都按这一个权重:
  ① 粒子感受到的场景风 × 权重(飞到边上风弱了、自己落下);过了 `ceiling` 上升气流 × 高度权重;
  ② 边带里**躺着**的薄片在查唤醒的子步上按 `(1−w)·Δt/4 s` 掷骰开始 1.5 s 淡出,淡完从区域深处补回;
  权重低于 0.02(压线 / 出框)的 0.4 s 淡出——普通粒子没有补回,淡完即死;
  ③ 出生 / 补回点按权重**拒绝采样**(边上天然稀),补回再从 0 淡入 0.6 s。
- 淡入淡出系数在通用池 `fade` / `fadeRate`,渲染乘到透明度上;**不限定的实例恒 1、一字不变**
  (风的乘子是精确的 ×1,确定性不受影响)。`arr.wind` 存的是**没衰减的**真实风——边带里躺着的纸
  照样跟着旁边的草一起掀边角。
- 🔴 **限定区域时补回的纸从低处放**(按平着自由下落 1 s 能落地定高度,纸钱 22–90 wu),不是原来的
  140–340 wu。从高处放的纸要飘好几秒、顺风走上千 wu,边带拦不住:强风合成场景实测每秒 9.4 张在下风边的
  半空里淡出(看着就是半空一张接一张消失);改后 0.04 张 / 秒。`vfxConfine.test.ts` 钉着(把高度改回去必红)。
- 🔴 **按权重拒绝采样会拒掉一大半**(两块区域只擦边重叠时九成以上挑空),落点挑不到时**不许回收**——
  回收就是总数一张张漏光(变异实测 20 s 从 341 掉到 285)。限定区域时挑落点试 96 次;淡完没挑到的隐身留着
  (`fade = 0`、`fadeRate > 0`)下个子步再试,每子步每发射器最多补回 4 张(稳态每子步 0.04 张,
  封顶只在两块不相交的退化场景里起作用,免得几百张 × 96 次表面查询打爆一帧)。
- 调试:F2「粒子」页每个实例带一行「深处 / 边带 / 淡出中 / 框外还看得见」,勾「画出粒子区域」叠加范围区域框线
  (黄)+ 边带中线(淡黄)+ 边带内沿(白)+ 单独配了范围区域时的发射区域(青),与编辑器画布同色。⚠ 内沿按**离框线的距离**取等值线(`confineDistanceContour`),
  别在权重网格上取 0.98:smoothstep 在 1 附近是平的,插值误差(≈ 格宽²·6/(8·边带²) = 0.047)大过余量,
  画出来是一圈坑坑洼洼的噪声(本会话当场踩到)。
- 群体发射器**不吃**这一项(用 `behavior.home.rangeRadius`),校验器 warning。
- **实测(2026-09-13,跑马梁,只改内存)**:520 张纸限定进一个 ~800×500 的四边形、边带 120,
  40 s 稳态框外看得见的平均 0.2 张、最远离框线 54.5(不到半个边带)、总数 520 不漏;
  整帧 `vfxSystem.update` 中位 0.4 ms / p95 0.8,与不限定时相同。
  分开配(发射区域是路中间 ~300×250 的一小块、范围区域同上那个四边形):出生 518/520 在发射区域里
  (另 2 张压线)、稳态 32% 的纸被风带出发射区域但仍在范围里、范围外看得见的 0、等补回的 0、update 中位 0.4 ms。

## 前后关系怎么定(分桶)

实体层的画序只认脚底 y([entitySortRule](../../src/rendering/entitySortRule.ts) 那套)。
实体在伪世界里是**立在脚点上的直立 quad**(角色着色 / 遮挡同一个模型),所以
"粒子在它前面" ⟺ 粒子沿**水平视线轴**(视线去掉竖直分量)比它的脚点近——**与离地多高无关**。
场上没标静态档位的实体按脚点 y 排好(= 画序)作阈值、各带脚点的水平纵深(脚点经
`groundWorldAtScene` 落到地面);粒子排在"画序里第一个比它近的实体"之前,桶网格的
`entitySortFootY` 取那个实体的脚点 y − ε。桶数 = 实体数 + 1,上限 `MAX_BUCKETS`(超了按分位数合并)。
纯函数 `buildSortThresholds / bucketOfDepth / bucketSortFootY` 在 `VfxRenderer.test.ts` 钉着。

⚠ 2026-09-12 之前比的是"粒子**正下方地面点**投到画面的 y":平地上与上面等价(平面近似下逐位相同),
但悬在更低地面上方的粒子(崖边的蝙蝠、檐口上的烟)正下方的地面点投到画面很靠下,被整批错排到人前面。
正下方地面点现在只管透视系数。

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
| **拿"有没有粒子被挡住"判遮挡坏没坏** | 大多数效果本来就在开阔处(崖墓前段绕人飞的蝙蝠、义庄的尘埃),被挡 0 颗是对的。验薄壳看 `sim.emitters[i].p.behind` 有没有置位、再比 `shellContact(...).penWu > depth_tolerance × wuPerQ` |
| **粒子 GLSL 只拼 `LC` 不拼 `WR_CORE`** | `LC` 的遮挡步进函数调 `WR_CORE` 的函数:编译失败,Pixi 只报 "Could not initialize shader",整批粒子不画(2026-09-12 当场踩到) |
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

- 单元:`vfxSim.test.ts`(确定性 / 不入地 / 不进壳 / **薄壳:侧面滑到柱子背后不被推出、壳厚内撞侧面、
  正面不隧穿、滞回、出生在背后、薄片同一条** / 惊起 → 惊散 → 回巢 / 子发射 / 大 dt 封顶)、
  `vfxConfine.test.ts`(权重网格几何 / 强风里纸钱被限定、总数不漏、边带渐稀、补回飞不过边带 / 普通粒子出框淡出 / 限高 / 不限定一字不变)、
  `VfxRenderer.test.ts`(曲线 + 按水平纵深分桶)、`vfxGeometry.test.ts`(与 `geometry.py` 的跨语言金标)、
  `worldSpaceShading.test.ts`(粒子不许自己写灯循环)。
- 构建期:`./dev.sh validate-data`(效果资产结构、场景实例含 `confine`、四条 action 的参数、`vfx` 条件叶);
  `asset_reference_audit --strict` 管贴图存在性。
- 真机:`?mode=dev&devScene=<场景>`,页内直读 `window.__game.vfxSystem`
  (`debugSnapshot()` / `stats` / `currentSpace`),按
  [runtime-command-channel](../recipes/runtime-command-channel.md) 驱动;
  **先确认 `currentSpace.kind === 'field'`**,否则所有几何判据都是空的。
  着色路直读 `window.__game.vfxRenderer.views`(`lit` / `toneSrc` / `depthGroup.uniforms.uHasDepth`);
  夜里是不是借了几何看 `characterLighting.isGeometryOnly`。
  画面取证走 [headless-visual-verification](../recipes/headless-visual-verification.md);
  F2「粒子」页有状态、只数、draw call、模拟毫秒与三个刺激按钮。

## 相关

- 作者面:[[vfx-workbench]]
- 坐标与单位:[[coordinate-spaces]]、[[lighting-scale-reference]]
- 受光同口径:[[character-lighting]]、[[scene-lighting]]
- 遮挡与脚点:[[entity-lighting]]
- 同为"烘焙 / 表演态 + 独立资产 + 独立工作台"的近亲:[[entity-trajectory]]
