---
id: scene-lighting
title: 场景背景受光(原画 + 加性实体灯)
domain: runtime
type: mechanism
summary: 原画就是最终的光照,运行时只把作者摆的实体灯加上去(先反解 albedo 再乘);天光与太阳的运行时加光项已删,「夜」靠换一张夜原画;两级 RT 缓存,稳态每帧零光照计算
status: active
authority:
  - src/rendering/lighting/SceneLightingPass.ts
  - src/rendering/lighting/LitBackground.ts
  - src/rendering/lighting/lightingCore.glsl
  - src/core/SceneLightingSystem.ts
  - src/utils/sceneAppearance.ts
  - tools/character_lighting_lab/scene_fields.py
triggers:
  paths: ["src/rendering/lighting/**", "src/core/SceneLightingSystem.ts", "src/utils/sceneAppearance.ts", "tools/scene_relight/**"]
  topics: [场景光照, 重打光, 原画, 实体灯, 加性灯, 夜景, 时段外观, timeVariants, 光晕, 统一光影]
  tasks: [摆灯, 调场景光照, 做夜景, 改光照 shader]
verified_by:
  - src/rendering/lighting/worldSpaceShading.test.ts
  - src/rendering/lighting/fog.test.ts
  - src/rendering/lighting/dehaze.test.ts
  - src/utils/sceneAppearance.test.ts
last_governed: 2026-08-31
---

## 是什么(一句话)

**原画就是最终的光照结果**(制作人 2026-08-30 定调),运行时不重新照亮它,
只把作者摆的**实体灯**加上去 —— 加之前先把 albedo 从原画里反解出来,
灯才乘在正确的反照率上:

```
surf = painting + clamp(painting / S_day, 0, 1) × Σ实体灯照度      (+ 灯体自发光/光晕)
```

**没有灯 ⇒ surf 恒等于 painting**,原画分毫不动。`S_day`(原画自带的自然光)
只剩"albedo 除数"这一个语义,**不再**是「参考光 vs 当前光」的比值。

角色侧是另一套(probe 底光 + 同一次打包的加性灯),见 [character-lighting](character-lighting.md);
阴影/遮挡/色调见 [entity-lighting](entity-lighting.md);单位与空间见 [lighting-scale-reference](lighting-scale-reference.md)。

## 权威源(读代码从哪进)

- `SceneLightingPass.ts` —— 合成式与灯循环,**头注释是模型的第一真相源**。
- `LitBackground.ts` —— 逐帧那一级(采样缓存 → 雾 → 显示变换)。
- `lightingCore.glsl` —— 各类灯的闭式解,场景与角色共用的唯一实现。
- `SceneLightingSystem.ts` —— 载荷装载、脏时重算、`wuPerQUnit` / `radianceScale`。
- `sceneAppearance.ts` —— 「此刻该显示哪张原画、配哪份参数」的纯解析。
- 离线端 `tools/character_lighting_lab/scene_fields.py` → `lighting/<背景基名>/`(几何项)。
  **烘焙只有这一个工具**(2026-08-31 收束):probe/体素/行走面与法线/天穹可见性同出同住。

## 硬契约(违反即 bug 的机制约束)

- **运行时不许再加一遍自然光**。天光与太阳的加光项已从 shader 删除;原画自带自然光,
  再算一遍就是重复计光。想让场景变暗**不要去调天光强度**——那条路已经没有了。
- **「夜」= 换一张夜原画**,加该时段的 probe 与该时段的灯。数据面是 `timeVariants[时段]`
  (顶层白天基底 ⊕ 该时段差异,`sceneAppearance.ts` 一次纯解析)。
  ⚠ 2026-08-21 曾把 `timeVariants` 判为死契约(那时统一光影要用运行时重打光取代它),
  **该判断已随模型翻转作废**,它现在是夜景的正路。
- **烘焙产物按第一层背景图名索引**。换时段 = 换主背景 = 换一整套烘焙目录
  (`lighting/<背景基名>/`,probe 与几何场同住)。**每张时段原画都要各烘一份**,
  只烘白天那张的话夜里就是"没烘载荷",整套安静禁用。
- **烘焙只有一个工具、一个目录**(制作人 2026-08-31 定):`tools/character_lighting_lab`
  产出一张背景图的**全部**派生物,落 `lighting/<背景基名>/`。别再另起一个 baker 或
  另开一个目录——同一份东西分两处放,打包规则、校验器、迁移脚本就要各写一套路径,
  其中任何一处少写一层就是**整批载荷静默不进包**(下面「已知坑」有实例)。
- **改产物布局要同步四处**,少一处就是运行时整包忽略或静默漏抽:
  `scene_fields.PAYLOAD_VERSION` / `SceneLightingSystem.LIGHTING_GEOMETRY_VERSION` /
  `validator._LIGHTING_GEOMETRY_VERSION` / `tools/build/manifest_rules.json`。
- **几何场必须从运行时实际 march 的那份深度烘**(`raw_depth_rg.png`),不是实验室内部
  精度更高的 `front_depth.bin`。用未量化的源反而与运行时对不上。深度重导后没重烘,
  靠 `geometry.json` 的 `depth_sha1` 抓(画面上只表现为"光的走向有点怪")。
- **albedo 反解必须钳到 1**。原画暗部除以一个小 `S_day` 会炸出巨大的假反照率,
  一盏灯扫过去就是一片过曝;上限 1.0 = 物理上反照率不可能超过 1。
- **灯体自发光不乘 albedo**(发光不是反射),单独累加。辐射场的 **alpha 存的是
  "灯体自发光占该像素的比例"**(0..1),不是绝对亮度——绝对阈值会随灯的强度漂。
- **显示变换绝不能进第一级**。缓存 RT 必须 RGBA16F 线性 HDR:把 ev 与 clamp 烤进 8bit
  实测让整张夜景的线性辐射最大值只剩 0.061、全图动态范围 17×。
- **显示变换必须同时作用于背景与角色**。背景走 `LitBackground`、角色是独立 sprite,
  两边不套同一组参数就会出现"背景很亮、角色漆黑"(雾津街头 ev=3.32 时实测)。
- **一切光照在世界空间、单位 wu**(铁律 0)。朝向过 R、尺度过 `wuPerQUnit`,一次转到底,
  不许停在"世界朝向 + q 尺度"那个没名字的中间态。正文见 [coordinate-spaces](coordinate-spaces.md)。
- **去霾的减法必须逐通道设下限**,不能硬钳到 0:霾是有颜色的,硬钳会让暗部通道非对称清零
  (蓝绿先死、红活下来 ⇒ 一片红噪点)。

## 已知坑

- **大气光晕沿视线积分,不是"表面点到灯的距离"**;而且**必须配高斯包络**——
  闭式解是 1/r⊥ 长尾,只积分不加包络会让光晕铺满 ≈100% 的像素。两条的实测数字与验尸
  在 [lighting-scale-reference](lighting-scale-reference.md) 的光晕两节,勿重犯。
- **一批"接着但没人读"的料**(2026-08-30 关掉统一角色路径后留下的,别当缺陷重报,
  也别据此以为它们在生效):`skyvis_grid.bin`(3D 天穹网格)与 `gi_hitmap.bin`
  **照旧烘,但运行时不装载、也不进发行包**(制作人 2026-08-31);
  `SceneLightingDef` 的 `radianceScale` / `characterShape` / `giGain` 同理(F2 里那几个
  旋钮此时不改画面)。`lighting.placeholder` 更彻底——运行时唯一判点在早退之后,
  **零消费者**,别再拿它判断"这个场景走哪条路"。
- **打包规则少写一层目录 = 整批载荷静默不进包**,而且构建、测试、验包全绿。
  2026-08-30 产物改成按背景图名分目录之后,`manifest_rules.json` 还停在
  `lighting/<文件名>`;fnmatch 的 `*` 虽然跨 `/`,但那几条结尾是字面文件名接不上,
  于是**probe 载荷一个都没进过发行包**,直到 2026-08-31 收束目录时才发现。
  `tools/build/tests` 里有一条对着**真实磁盘布局**验的护栏,别删。
- 同一形态的第二例:编辑器 `SceneLightSpace.wu_per_q` 把路径写死成扁平的
  `lighting2/meta.json`,命中不了就**静默回落 1.0**——而真值逐场景 154–880,
  摆灯位置全错且不报错。**路径别写死,按背景图名推**。
- **`extract.pixels` 读不了浮点 RT**(RGBA16F 取出来恒全 0 且不报错)。验辐射场只能走
  正常渲染路径(切调试视图 + 取屏)。
- **背景重画了不重烘,不会报错到画面上**,只在 `validate-data` 的 `[lighting-bake]`
  与发行前的 `checkBakeFreshness` 里说话(见 [build-pipeline](build-pipeline.md))。

## 怎么验证

- `npx vitest run src/rendering/lighting src/utils/sceneAppearance.test.ts`
- `sh scripts/py.sh -m pytest tools/character_lighting_lab/tests tools/build/tests -p no:cacheprovider`
- 重烘一个场景:`sh scripts/py.sh -m tools.character_lighting_lab.scene_fields --scene <id>`
- 调试视图(`SceneLightingPass` 的 `uDebug`)逐项看:天穹可见性 / 法线 / `S_day` /
  纯灯照度 / 反解 albedo / 原画。**"没灯时与原画逐像素相等"是这套模型的恒等锚**,
  改合成式后必须先验它。
- 画面取证走 [headless-visual-verification](../recipes/headless-visual-verification.md)。
