---
id: scene-lighting
title: 场景背景受光(原画 + 加性实体灯)
domain: runtime
type: mechanism
summary: 原画就是最终的光照,运行时只把作者摆的实体灯加上去(乘在**烘出来的 albedo 贴图**上);天光与太阳的运行时加光项已删,「夜」靠换一张夜原画;两级 RT 缓存,稳态每帧零光照计算
status: active
authority:
  - src/rendering/lighting/SceneLightingPass.ts
  - src/rendering/lighting/LitBackground.ts
  - src/rendering/lighting/lightingCore.glsl
  - src/core/SceneLightingSystem.ts
  - src/utils/sceneAppearance.ts
  - tools/character_lighting_lab/scene_fields.py
triggers:
  paths: ["src/rendering/lighting/**", "src/core/SceneLightingSystem.ts", "src/core/lightingPayloadFiles.ts", "src/utils/sceneAppearance.ts", "tools/scene_relight/**"]
  topics: [场景光照, 重打光, 原画, 实体灯, 加性灯, 夜景, 时段外观, timeVariants, 光晕, 统一光影, albedo, 反照率, 材质底色]
  tasks: [摆灯, 调场景光照, 做夜景, 改光照 shader, 改 albedo, 烘 albedo]
verified_by:
  - src/rendering/lighting/worldSpaceShading.test.ts
  - src/rendering/lighting/fog.test.ts
  - src/rendering/lighting/dehaze.test.ts
  - src/utils/sceneAppearance.test.ts
last_governed: 2026-09-07
---

## 是什么(一句话)

**原画就是最终的光照结果**(制作人 2026-08-30 定调),运行时不重新照亮它,
只把作者摆的**实体灯**加上去 —— 灯乘在**烘出来的 albedo 贴图**上:

```
surf = painting + albedo贴图 × Σ实体灯照度      (+ 灯体自发光/光晕)
```

**没有灯 ⇒ surf 恒等于 painting**,原画分毫不动。

**albedo 是一张烘出来的图**(制作人 2026-09-07 定),不再是 shader 里现除的
`painting / S_day`:

```
albedo.png = clamp(linear(主背景原画) / ((1-day_hemi) + day_hemi × skyvis), 0, 1)   # 离线
```

- 默认值与旧的现除**逐字同式**(太阳项恒 0——实测 28/28 个场景 `day.sunIntensity`
  都填 0,那一项从来没生效过),所以切过来那一刻**画面等价**;变的是**作者能改它了**。
- **全时段共用主背景那一张**:材质不随时段变,夜里灯照到墙上要显出墙本来的颜色,
  而不是夜原画里那层暗蓝。时段目录里放的是同一份字节。
- **作者手改的不会被重烘覆盖**:`geometry.json` 的 `albedo_map.authored=true` 时
  烘焙器跳过并出声,要覆盖得显式 `--force-albedo`。
- `S_day` 与它的两个输入(`skyvis.png`、拟合出的 `day_hemi`)**整段搬去了离线端**;
  `lighting.sky` / `lighting.day` 两块数据字段随之下线(`sky.intensity` 除外,见下)。

角色侧是另一套(probe 底光 + 同一次打包的加性灯),见 [character-lighting](character-lighting.md);
阴影/遮挡/色调见 [entity-lighting](entity-lighting.md);单位与空间见 [lighting-scale-reference](lighting-scale-reference.md)。

## 权威源(读代码从哪进)

- `SceneLightingPass.ts` —— 合成式与灯循环,**头注释是模型的第一真相源**。
- `LitBackground.ts` —— 逐帧那一级(采样缓存 → 雾 → 显示变换)。
- `lightingCore.glsl` —— 各类灯的闭式解,场景与角色共用的唯一实现。
- `SceneLightingSystem.ts` —— 载荷装载、脏时重算、`wuPerQUnit` / `radianceScale`。
- `sceneAppearance.ts` —— 「此刻该显示哪张原画、配哪份参数」的纯解析。
- 离线端 `tools/character_lighting_lab/scene_fields.py` → `lighting/<背景基名>/`
  (几何项 + **albedo 贴图**,后者见 `build_albedo` / `bake_albedo_only`)。
  **烘焙只有这一个工具**(2026-08-31 收束):probe/体素/行走面与法线/天穹可见性同出同住。
- `src/core/lightingPayloadFiles.ts` —— **运行时到底读哪些文件**的唯一真相源
  (打包与验收各有一份镜像,契约测试逐字比对)。场景侧现在是
  `geometry.json` / `normal.png` / `albedo.png`;`skyvis.png` 已不在其中。

## 硬契约(违反即 bug 的机制约束)

- **运行时不许再加一遍自然光**。天光与太阳的加光项已从 shader 删除;原画自带自然光,
  再算一遍就是重复计光。想让场景变暗**不要去调天光强度**——那条路已经没有了。
- **「夜」= 换一张夜原画**,加该时段的 probe 与该时段的灯。数据面是 `timeVariants[时段]`
  (顶层白天基底 ⊕ 该时段差异,`sceneAppearance.ts` 一次纯解析)。
  ⚠ 2026-08-21 曾把 `timeVariants` 判为死契约(那时统一光影要用运行时重打光取代它),
  **该判断已随模型翻转作废**,它现在是夜景的正路。
  **编辑入口只有一个**(2026-09-04):场景属性面板「日夜与出口」块的时段表
  (`+ 时段外观…` 建一行,选中行即下方表单,`scene_time_variant_form.py`),变体里的
  **每一项**都在表单上:背景原画、七个环境块逐字段(sky/fog/display/emissive/dehaze/giGain/
  aoStrength,每块一个「覆盖」勾,勾上那一刻从白天基底预填)、depthConfig(整份复制白天的再改
  图名)、环境音列表、BGM、滤镜,后四项都是三态(沿用白天 / 覆盖成某值 / 覆盖成空)。
  灯不在变体里,按各自的「时段归属」过滤。此前面板只能改背景、环境靠整块快照、其余只能手写 JSON,
  而且「+ 时段外观…」按钮读的是一个不存在的属性,一点就 AttributeError——弹窗从没出来过。
- **烘焙产物按第一层背景图名索引**。换时段 = 换主背景 = 换一整套烘焙目录
  (`lighting/<背景基名>/`,probe 与几何场同住)。**每张时段原画都要各烘一份**,
  只烘白天那张的话夜里就是"没烘载荷",整套安静禁用。
  ⚠ **`albedo.png` 是这条规则的唯一例外**:它按**主背景**算一次,各时段目录里放的是
  同一份字节(材质不随时段变)。所以它由 `albedo_map.from_background` 说清来历,
  新鲜度门比的也是**主背景**的哈希,不是本目录那张背景的。
- **烘焙只有一个工具、一个目录**(制作人 2026-08-31 定):`tools/character_lighting_lab`
  产出一张背景图的**全部**派生物,落 `lighting/<背景基名>/`。别再另起一个 baker 或
  另开一个目录——同一份东西分两处放,打包规则、校验器、迁移脚本就要各写一套路径,
  其中任何一处少写一层就是**整批载荷静默不进包**(下面「已知坑」有实例)。
- **改产物布局要同步四处**,少一处就是运行时整包忽略或静默漏抽:
  `scene_fields.PAYLOAD_VERSION` / `SceneLightingSystem.LIGHTING_GEOMETRY_VERSION` /
  `validator._LIGHTING_GEOMETRY_VERSION` / `tools/build/manifest_rules.json`。
- **「约定路径被多方消费」是一个缺陷类,必须用结构堵,不许靠"改的时候记得全改"**:
  要么这条路径**由单一函数产出**(运行时侧已经是这样),要么就得有一条
  **对着真实磁盘布局验、而不是对着规则字符串验**的护栏。
  理由是这类漏写**全都不报错**:`fnmatch` / 正则 / 路径拼接都合法,只是匹配到空集或
  落到不存在的路径,然后各自"优雅降级"过去。实例见下方「已知坑」的四连发。
- **降级必须出声**。上面那一类之所以能潜伏,是因为消费方的降级分支是哑的
  (`except` 回落缺省值 / 过滤后为空就跳过 / 匹配 0 条就静默)。
  凡是"读不到就用个兜底值继续"的写法,**必须留下人看得见的痕迹**——
  一条静默的兜底,与"这一级根本没在跑"在现象上完全无法区分。
- **几何场必须从运行时实际 march 的那份深度烘**(`raw_depth_rg.png`),不是实验室内部
  精度更高的 `front_depth.bin`。用未量化的源反而与运行时对不上。深度重导后没重烘,
  靠 `geometry.json` 的 `depth_sha1` 抓(画面上只表现为"光的走向有点怪")。
- **albedo 反解必须钳到 1**(现在这条约束住在**离线端** `build_albedo`)。原画暗部
  除以一个小 `S_day` 会炸出巨大的假反照率,一盏灯扫过去就是一片过曝;
  上限 1.0 = 物理上反照率不可能超过 1。
- **albedo 存 sRGB8,不存线性 8 位**。反照率的暗部占掉大半个值域,线性量化在那里丢档;
  sRGB 编码感知均匀,而且用图像软件打开就是"看起来正常的材质图"——**作者手改这张图
  时看到的是自己认得的东西**。运行时读回时过 `lcSrgbToLinear`,与原画同一条解码路径。
- **烘 albedo 用的 skyvis 必须是落盘那张 `skyvis.png`**,不是内存里那份未量化的 float 场。
  同一条教训在几何场那边已经写着(必须从运行时实际 march 的那份深度烘):拿更精确的源
  反而与消费端对不上。
- **作者手改过的 albedo 不许被重烘悄悄覆盖**。`albedo_map.authored=true` 时烘焙器跳过
  并打印一行;要覆盖只能显式 `--force-albedo`。配套的 `albedo_map.source_sha1` 记的是
  生成它时**主背景**的哈希——背景重画而 albedo 没跟上是一种只有校验器抓得住的静默错,
  画面上只表现为"灯照上去颜色有点怪"。
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

- **2026-08-30 ~ 09-10 所有点光/聚光对背景与角色全灭,零报错**:铁律 0 把 shader 的 r 换成 wu 后
  intensity 没跟着换尺(差 `wuPerQUnit²`)、线扫前缀灯位没除 `wuPerQUnit`,两处叠着,
  载荷/打包/uniform 全部正常。正文与取证办法见 [lighting-scale-reference](lighting-scale-reference.md)
  已知坑 ⑦。快速判据:uDebug=3(灯的辐照度)一片黑 = 灯根本没算出来,**先查尺,别查载荷**。
- **大气光晕沿视线积分,不是"表面点到灯的距离"**;而且**必须配高斯包络**——
  闭式解是 1/r⊥ 长尾,只积分不加包络会让光晕铺满 ≈100% 的像素。两条的实测数字与验尸
  在 [lighting-scale-reference](lighting-scale-reference.md) 的光晕两节,勿重犯。
- **一批"接着但没人读"的料**(2026-08-30 关掉统一角色路径后留下的,别当缺陷重报,
  也别据此以为它们在生效):`skyvis_grid.bin`(3D 天穹网格)与 `gi_hitmap.bin`
  **照旧烘,但运行时不装载、也不进发行包**(制作人 2026-08-31);
  `SceneLightingDef` 的 `radianceScale` / `characterShape` / `giGain` 同理(F2 里那几个
  旋钮此时不改画面)。`lighting.placeholder` 更彻底——运行时唯一判点在早退之后,
  **零消费者**,别再拿它判断"这个场景走哪条路"。
- **「少写一层目录」的四连发(2026-08-31 一次清完,当反面教材读)**:产物 2026-08-30 改成
  按背景图名分目录后,四处消费方各自漏了那一层,**四处全都不报错**——
  ① 打包规则匹配 0 条 ⇒ **probe 载荷一个都没进过发行包**;
  ② 发行前的新鲜度门过滤后为空 ⇒ 打印"没有载荷,跳过",那道门**一直在空转**;
  ③ 编辑器读不到就 `except` 回落 1.0 ⇒ 摆灯的世界尺度差三个数量级;
  ④ 深度审计对**每一个**场景都报"缺目录" ⇒ 全量误报,等于这道门也没了。
  同期另一个消费方写对了(它按背景图名推),所以**四处坏一处好,肉眼看不出是一类问题**。
  现在有一条对着**真实磁盘布局**验的护栏钉着(`tools/build/tests`),别删。
- **`extract.pixels` 读不了浮点 RT**(RGBA16F 取出来恒全 0 且不报错)。验辐射场只能走
  正常渲染路径(切调试视图 + 取屏)。
- **背景重画了不重烘,不会报错到画面上**,只在 `validate-data` 的 `[lighting-bake]`
  与发行前的 `checkBakeFreshness` 里说话(见 [build-pipeline](build-pipeline.md))。
- **`lighting.sky` 整块看着像死料,但 `sky.intensity` 是活的**:它是**实体影子浓度**
  自动解算时的环境照度分母(`Game.resolveLightEnv` → `entityShadowBinding`,F2 里那条
  滑条叫"影子环境照度")。2026-09-07 清理时数了一遍 shader uniform 的引用数就断定
  "sky 整块没人读"——错的,那条路根本不经 shader。删它影子浓度会跟着变。
  同块的 `hemi`/`color`/`kelvin` 确实只剩停用的统一角色路径在读。

## 怎么验证

- `npx vitest run src/rendering/lighting src/utils/sceneAppearance.test.ts`
- `sh scripts/py.sh -m pytest tools/character_lighting_lab/tests tools/build/tests -p no:cacheprovider`
- 重烘一个场景:`sh scripts/py.sh -m tools.character_lighting_lab.scene_fields --scene <id>`
- 只补/刷新 albedo(不重跑任何 march,29 份载荷全量 40 秒):
  `... scene_fields --all --albedo-only`(加 `--force-albedo` 才覆盖作者手改的)
- 调试视图(`SceneLightingPass` 的 `uDebug`,F2 那个循环按钮)逐项看:
  0=正常 1=法线 2=**albedo 贴图** 3=灯的辐照度 4=线性化原画 5..9=GI/skyao 体。
  ⚠ 2026-09-07 **重编号**(「天穹可见性」与「S_day」两档随 skyvis 退出运行时删掉),
  编号在三处必须一致:shader 的 `if (uDebug == n)` / `DebugTools.DEBUG_NAMES` 的下标 /
  `Game.setSceneLightingDebug` 的范围判断。
  **"没灯时与原画逐像素相等"是这套模型的恒等锚**,改合成式后必须先验它。
- 编辑器侧:场景属性面板「统一光影 lighting」块里有 albedo 的状态行(烘的/作者手改/
  与主背景是否同步)、「重生成默认 albedo」按钮与「画布底图看 albedo」开关。
- 画面取证走 [headless-visual-verification](../recipes/headless-visual-verification.md)。
