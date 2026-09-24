---
id: scene-lighting
title: 场景背景受光(原画 + 加性实体灯)
domain: runtime
type: mechanism
summary: 原画就是最终的光照,运行时只把作者摆的实体灯加上去(乘在**烘出来的 albedo 贴图**上);天光与太阳的运行时加光项已删,「夜」靠换一张夜原画;两级 RT 缓存,稳态每帧零光照计算;唯一的镜面项 = 打了反光位的灯(落雷)在**任何地方**的 GGX 反射(没画区域的地方用全局缺省材质,水面 / 石板地另画区;程序化细节法线把高光打碎),平时画面一个像素都不变
status: active
authority:
  - src/rendering/lighting/SceneLightingPass.ts
  - src/rendering/lighting/LitBackground.ts
  - src/rendering/lighting/lightingCore.glsl
  - src/core/SceneLightingSystem.ts
  - src/rendering/lighting/surfaceMask.ts
  - src/utils/sceneAppearance.ts
  - tools/character_lighting_lab/scene_fields.py
triggers:
  paths: ["src/rendering/lighting/**", "src/core/SceneLightingSystem.ts", "src/core/lightingPayloadFiles.ts", "src/utils/sceneAppearance.ts", "tools/scene_relight/**"]
  topics: [场景光照, 重打光, 原画, 实体灯, 加性灯, 夜景, 时段外观, timeVariants, 光晕, 统一光影, albedo, 反照率, 材质底色, 线光, 镜面, 反光, 倒影, 水面, 湿地, 表面材质区]
  tasks: [摆灯, 调场景光照, 做夜景, 改光照 shader, 改 albedo, 烘 albedo, 天气压暗]
verified_by:
  - src/rendering/lighting/worldSpaceShading.test.ts
  - src/rendering/lighting/fog.test.ts
  - src/rendering/lighting/dehaze.test.ts
  - src/utils/sceneAppearance.test.ts
  - src/rendering/lighting/lightPackingLine.test.ts
last_governed: 2026-09-24
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
- **作者手改的不会被重烘覆盖**(见硬契约)。
- `S_day` 与它的两个输入(`skyvis.png`、拟合出的 `day_hemi`)**整段搬去了离线端**;
  `lighting.sky` / `lighting.day` 两块数据字段随之下线(`sky.intensity` 除外,见下)。

角色侧是另一套(probe 底光 + 同一次打包的加性灯),见 [character-lighting](character-lighting.md);
阴影/遮挡/色调见 [entity-lighting](entity-lighting.md);单位与空间见 [lighting-scale-reference](lighting-scale-reference.md)。

## 权威源(读代码从哪进)

- `SceneLightingPass.ts` —— 合成式与灯循环,**头注释是模型的第一真相源**。
- `LitBackground.ts` —— 逐帧那一级(采样缓存 → 雾 → 显示变换)。
- `lightingCore.glsl` —— 各类灯的闭式解,场景与角色共用的唯一实现。
- `SceneLightingSystem.ts` —— 载荷装载、脏时重算、`wuPerQUnit`、运行时灯与压暗(`effectiveLights` / `setEnvDim`)。
- `sceneAppearance.ts` —— 「此刻该显示哪张原画、配哪份参数」的纯解析。
- 离线端 `tools/character_lighting_lab/scene_fields.py` → `lighting/<背景基名>/`
  (几何项 + **albedo 贴图**,后者见 `build_albedo` / `bake_albedo_only`)。
  **烘焙只有这一个工具**(2026-08-31 收束):probe/体素/行走面与法线/天穹可见性同出同住。
- `src/core/lightingPayloadFiles.ts` —— **运行时到底读哪些文件**的唯一真相源
  (打包与验收各有一份镜像,契约测试逐字比对)。场景侧现在是
  `geometry.json` / `normal.png` / `albedo.png`;`skyvis.png` 已不在其中。
  同目录的可选件还有背景草木摆动拆层 `sway.json` / `sway_plate.png` / `sway_matte.png` / `sway_ids.png`
  (不是光照量,是结构派生物;全时段共用主背景那份,见 [background-sway](background-sway.md))。

## 硬契约(违反即 bug 的机制约束)

- **场景打不打光只看"当前这张原画烘没烘几何场"(+ 有 depthConfig),不看场景 JSON 写没写 `lighting` 块**
  (2026-09-14)。块里只装**作者的**灯与显示参数;没写块 = 用缺省块 `src/data/scene_lighting_default.json`
  (无灯、显示恒等、不去霾 ⇒ 画面 = 原画)。运行时灯(手持火把 / 跟随灯)不归作者块管。
  (原来没写块就不打光,于是恒等迁移之后才烘的场景举着火把一点光都没有。)
  同一条判据**三处共用**,改一处要看另外两处:运行时 `SceneLightingSystem.load`、
  草木烘焙 `sway_field._slot_lit`(决定出不出打光场景的漏出处补图)、校验器 `_lighting_geometry_issues`
  (有 depthConfig 的场景都查)。缺省块的值**只有一份**:编辑器 `scene_lights.default_lighting_block`
  读同一个 JSON —— 作者在没写块的场景摆第一盏灯时落盘的就是运行时正在用的那份,
  不会因为"多了一盏灯"整个场景色调映射跟着变。
- **运行时不许再加一遍自然光**。天光与太阳的加光项已从 shader 删除;原画自带自然光,
  再算一遍就是重复计光。想让场景变暗**不要去调天光强度**——那条路已经没有了。
- **「夜」= 换一张夜原画**,加该时段的 probe 与该时段的灯。数据面是 `timeVariants[时段]`
  (顶层白天基底 ⊕ 该时段差异,`sceneAppearance.ts` 一次纯解析)。
  ⚠ 2026-08-21 曾把 `timeVariants` 判为死契约(那时统一光影要用运行时重打光取代它),
  **该判断已随模型翻转作废**,它现在是夜景的正路。
  **编辑入口只有一个**(2026-09-04):场景属性面板「日夜与出口」块的时段表
  (`scene_time_variant_form.py`),变体里的**每一项**都在表单上,环境块逐块「覆盖」勾、
  音频 / 滤镜三态(沿用白天 / 覆盖成某值 / 覆盖成空)。灯不在变体里,按各自的「时段归属」过滤。
- **烘焙产物按第一层背景图名索引**。换时段 = 换主背景 = 换一整套烘焙目录
  (`lighting/<背景基名>/`,probe 与几何场同住)。**每张时段原画都要各烘一份**,
  只烘白天那张的话夜里就是"没烘载荷",整套安静禁用。
  入口只有一条:`scene_fields --scene <id>` 烘该场景**全部**时段原画;时段原画还没有 probe 载荷时,
  它先调 `pipeline.seed_phase_payload` —— 拷主背景的几何件(`lighting.json` / `ground_d.png` /
  `probes_valid.bin`)再 `rebake_lighting` 按这张画重烘图集并**自己改写 `background_sha1`**。
  ⚠ **不许对时段原画跑 `build`**:暗图重估的深度是乱的,而各时段共用一份深度 / 碰撞。
  ⚠ 时段原画必须与白天**逐像素同尺寸对齐**(`seed_phase_payload` 与校验器都拦);对不齐先修画
  (常见病:夜图是白天居中裁掉几行、或另一次渲染的不同尺寸;原图留 `*.unaligned.bak`)。
  时段没烘、或只烘了 probe 没烘几何场,都表现为"夜里火把不亮"。
  ⚠ **`albedo.png` 是这条规则在烘焙侧的唯一例外**:它按**主背景**算一次,各时段目录里放的是
  同一份字节(材质不随时段变)。所以它由 `albedo_map.from_background` 说清来历,
  新鲜度门比的也是**主背景**的哈希,不是本目录那张背景的。
  ⚠ **运行时侧还有一条兜底**(2026-09-12):时段原画**没烘**、且变体**没换深度图**时,
  `CharacterLightingSystem.loadGeometryOnly` 借主背景那份的**几何项**(行走面 + 标定;
  "各时段必须共享几何"本来就是校验器的硬规则),**光照项一概不借**(`resources` 保持 null,
  角色退 EntityLightingFilter、粒子退色调融入)。它只让脚点遮挡 / 粒子的地面与墙 / 空间音不再
  退平面近似,**不是**"可以不烘夜图"——夜里的 probe 仍要给那张原画单独烘。
- **烘焙只有一个工具、一个目录**(制作人 2026-08-31 定):`tools/character_lighting_lab`
  产出一张背景图的**全部**派生物,落 `lighting/<背景基名>/`。别再另起一个 baker 或
  另开一个目录——同一份东西分两处放,打包规则、校验器、迁移脚本就要各写一套路径,
  其中任何一处少写一层就是**整批载荷静默不进包**(下面「已知坑」有实例)。
- **几何场载荷不按版本号判真假**(2026-09-14)。运行时与校验器按**运行时真正读的东西**验:
  文件 `lightingPayloadFiles.LIGHTING_GEOMETRY_FILES`、meta 字段 `LIGHTING_GEOMETRY_META_REQUIRED`
  (Python 镜像在 `validator._LIGHTING_GEOMETRY_META_REQUIRED`,契约测试逐字比)。
  `scene_fields.PAYLOAD_VERSION` 只剩烘焙器自己的记录;`--albedo-only` 不改写它
  (它一个 march 都不跑,盖成新代次等于谎报几何是新烘的)。代次号曾手抄在三处、无测试绑、还有一份落后。
  **改产物布局时改那两张表**(连同 `tools/build/manifest_rules.json`),不要再加"代次必须相等"。
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
- **运行时压暗(天气 / 演出的 envDim)只能走显示曝光,且曝光的真实消费者是第二级 `LitBackground`**。
  原画就是最终光照、作者灯是加性的,把灯调到 0 压不暗原画;`setEnvDim` 把倍率折成 `display.ev` 的档位。
  推参数时第二级必须一起推——只推给第一级 pass(它写线性辐射缓存,不管屏幕亮度)就是"数值到了、背景
  几乎不变"(2026-09-20 雷符实测:envDim 0.24 人变暗、道路不动)。角色 / 粒子那份乘在受光总倍率上
  (见 [character-lighting](character-lighting.md)),两边由 `Game` 一个入口同值推;不落盘,切场景清空。
  每变一次整张缓存重算,渐变要限速。**验收同时看背景、人物、粒子**,不能凭 envDim 数值判压暗成功。
  ⚠ 渐变的接管令牌是模块级全局,**切场景不作废它**(只有演出会话收尾作废),在途渐变会追到新场景里;
  没有光照 pass 的场景只压得到角色 / 粒子那一侧,背景不动。
- **一切光照在世界空间、单位 wu**(铁律 0)。朝向过 R、尺度过 `wuPerQUnit`,一次转到底,
  不许停在"世界朝向 + q 尺度"那个没名字的中间态。正文见 [coordinate-spaces](coordinate-spaces.md)。
- **去霾的减法必须逐通道设下限**,不能硬钳到 0:霾是有颜色的,硬钳会让暗部通道非对称清零
  (蓝绿先死、红活下来 ⇒ 一片红噪点)。

## 线光与镜面反光(2026-09-24,落雷对齐参考图)

- **线光** `kind: 'line'`(`LightDef.to` = 终点,M-world):落雷沿雷身摆的那几段。`lcLineLight` 是沿线的 Lambert 解析积分,
  场景 / 角色 / 粒子三条灯循环都有这个分支(粒子经 `ENTITY_SCENE_LIGHTS_GLSL`)。打包:A = 起点,D.xyz = 终点 − 起点,
  强度与点光同一套 q 相对折法(× wuPerQUnit²)。
- **反光位** `LightDef.reflect`(flags bit2)只有落雷的运行时灯打;作者灯一律不进镜面项。
- **镜面项只在场景 pass 里,任何地方都有**:`surf = painting + albedo × lampE + specE × 反光强度`。
  **雷是任意地方随机落的**(制作人 09-24:「这些雷电不能是场景特调」)——没画区域的地方一律用**全局缺省材质**
  (布置库顶层 `defaultSurface`:反光 / 粗糙度 / 细节起伏 / 水面雨纹,所有场景一份,缺省 1 / 0.45 / 1 / 1);
  区(`scenes[场景].surfaces`,场景级、所有时段共用)只标材质真正不一样的地方:水体(河、潭、港湾、水坑、海)与石板铺地,
  **不许按参考图里雷劈的位置去圈**。两者画成一张遮罩(底色 = 缺省材质;r 反光 / g 粗糙度 / b 是不是水,`surfaceMask.ts`,
  后画的盖前面的);本场景一块区都没有时不要图,shader 直接用 `uSurfDefault`。粒子工作台是唯一写入者。
- **反光必须基于物理**(制作人 09-24:「倒影必须基于物理,不能瞎搞」;对参考图「看得出是倒影即可,不需要精确匹配」):
  - GGX 微表面(`specGGX`,与漫反射同尺 = π·f·E),水 F0 = 0.02、湿地 0.04,世界空间,视线 = 标定 R 的第三列取反。
  - **细节法线**(制作人 09-24:「光改粗糙度没有法线效果很假……法线不需要和场景匹配,只要能看到光照效果」):
    只进镜面项,漫反射照旧用烘的法线。地面 / 湿地 = 烘的法线 + 四级值噪声的斜率(波长 22 / 9 / 4 / 1.8 wu,自相似、
    每级转一个角避开方格感);水面 = 世界向上的平法线 + 雨点涟漪(每 9 wu 一个雨点、圈扩到 5 wu、波长 1.6 wu)+ 弱细浪。
    **逐级按像素足迹淡出**(波长小于三个像素的不画),淡掉的那部分斜率方差并进 α²(Toksvig):远处 / 斜看自然退成一片柔光、不闪。
    强度两个全局量:`defaultSurface.detail`(所有地面)、`defaultSurface.ripple`(所有水面)。
  - **线光的镜面 = 沿线积分**:代表点(线上离反射光线最近的点,Karis 2013)处的 f,乘瓣沿线张开的长度
    `w = π·α·r / sinφ`(GGX 在半角上 ∫D/D峰 = πα/2,反射角是半角两倍;α = 粗糙度²),瓣比线宽时取线长。
    ⚠ 09-24 第一版把 w 写成 `2·r·粗糙度`(拿粗糙度当 α),亮了约 5 倍,倒影成了一条糊白的宽带。
  - **平行光(被照亮的整片云)按铺满天的面光算**:镜面 = F(n·v) × 水平照度(E = π·L,输出按 π·辐亮度记),
    平静水面正看约 2%,越斜越亮——整片水面随雷亮一下,不是一个点光高光。
  - 倒影的长短 / 宽窄由几何与粗糙度自己出来(雷多高、看得多斜),**不许按"只让雷的下半截反光"之类的截断去凑参考图**。
  - 抓图对比时**从雷真出现那一拍算时刻**:效果第一次装载是异步的,从发车算的话第一道落在主闪、后面几道已经在衰减里,
    同一张图几道雷亮度差很多,会被误判成"有的地方亮有的不亮"。

## 已知坑

- **换表面材质区的遮罩:先换绑、再销毁旧的**(Pixi 坑②同一个):旧遮罩还绑在两份 shader 的 BindGroup 上时 `destroy(true)`,
  BindGroup 永久烧毁,之后每帧 `setTime` 都抛、整条光照停摆。只在**运行时改区**时触发(工作台联动一改表面区就中),
  进场景那一次不中——09-24 抓图时才撞到。
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

- `npx vitest run src/rendering/lighting src/utils/sceneAppearance.test.ts src/core/SceneLightingSystem.defaults.test.ts`
  (`lightPackingLine.test.ts` 钉线光 / 反光位的打包格式)
- 反光的画面验收:整图取景抓落雷那一帧(约 67 ms)对着参考图看"看得出是倒影";验遮罩朝向可以临时把下半张图设成水面
  (反光只该出现在下半张)。
  (后者还扫一遍盘上每一份 `geometry.json` 过不过得了运行时的字段门)
- `sh scripts/py.sh -m pytest tools/character_lighting_lab/tests tools/build/tests -p no:cacheprovider`
- 重烘一个场景:`sh scripts/py.sh -m tools.character_lighting_lab.scene_fields --scene <id>`
- 只补/刷新 albedo(不重跑任何 march,29 份载荷全量 40 秒):
  `... scene_fields --all --albedo-only`(加 `--force-albedo` 才覆盖作者手改的)
- 调试视图(`SceneLightingPass` 的 `uDebug`,F2 那个循环按钮)逐项看:
  0=正常 1=法线 2=**albedo 贴图** 3=灯的辐照度 4=线性化原画 5..9=GI/skyao 体。
  ⚠ 2026-09-07 **重编号**(「天穹可见性」与「S_day」两档随 skyvis 退出运行时删掉),
  编号在三处必须一致:shader 的 `if (uDebug == n)` / `DebugTools.DEBUG_NAMES` 的下标 /
  `Game.setSceneLightingDebug` 的范围判断。
  **"没灯时 ≈ 原画"是这套模型的恒等锚**,改合成式后必须先验它。⚠ 字面上**不是逐像素相等**:
  线性化 → 0 灯重算 → 显示变换 → 8 位编码这一圈有量化残差,实测(崖墓入口恒等块同机位)是
  **均匀增益约 +1%、平均差 < 1/255、三通道同幅不偏色、随亮度线性**。合格判据 = 这种均匀小增益;
  出现偏色、局部差、或偏移而非增益才是合成式坏了。
- 编辑器侧:场景属性面板「统一光影 lighting」块里有 albedo 的状态行(烘的/作者手改/
  与主背景是否同步)、「重生成默认 albedo」按钮与「画布底图看 albedo」开关。
- 画面取证走 [headless-visual-verification](../recipes/headless-visual-verification.md)。
