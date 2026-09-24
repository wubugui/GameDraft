---
id: character-lighting
title: 角色逐像素照明(probe 底光 + 加性实体灯)
domain: runtime
type: mechanism
summary: 只有一条活路径——probe 烘死的 GI 底光 + 与场景同一次打包的加性实体灯 + 与背景同一组显示变换;统一角色路径被 Game 里的常量开关整条关死(留码不删);着色核心单一 GLSL 源,法线必须与 color 同 UV 采样、格边界与运行时 stride 对齐;probe 烘焙与方向基见 character-probe-bake
status: active
authority:
  - src/core/Game.ts#UNIFIED_CHAR_PATH_ENABLED
  - src/core/CharacterLightingSystem.ts
  - src/data/lightFactors.ts
  - src/rendering/CharacterLitSprite.ts
  - src/rendering/charShadeCore.glsl
  - src/rendering/CharacterShadingFilter.ts
  - src/rendering/spriteNormalAtlas.ts
  - src/rendering/lighting/lightingCore.glsl
  - src/core/lightingPayloadFiles.ts
  - tools/animation_pipeline/bake_normal_atlas.py
triggers:
  paths: ["src/rendering/lighting/**", "src/core/UnifiedCharacterLighting.ts", "src/rendering/charShadeCore.glsl", "src/rendering/CharacterLitSprite.ts", "src/rendering/CharacterShadingFilter.ts", "src/rendering/spriteNormalAtlas.ts", "src/core/CharacterLightingSystem.ts", "src/data/lightFactors.ts", "tools/animation_pipeline/bake_normal_atlas.py"]
  topics: [角色照明, probe, 法线图集, 伪世界照明, CHAR_FS, 体素卷, 融入场景, 加性灯, 受光倍率, lightFactors, eChroma, 天穹可见性, radianceScale]
verified_by:
  - src/rendering/lighting/worldSpaceShading.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

按角色法线逐像素给玩家 / NPC / 挂件打光。**只有一条活路径**(2026-08-30 起):

```
E = probe 图集查表(以 q 为方向基的烘焙载荷, GI 底光) + 场景实体灯(M-world, wu, 加性)
角色 = color × 倍率(E) → 显示变换
```

底光来自同一张原画烘出的 probe(烘焙参数与方向基见 [character-probe-bake](character-probe-bake.md)),
灯与场景背景吃**同一次 `packLights`**,「灯对角色和场景一视同仁」是构造性的。
场景背景见 [scene-lighting](scene-lighting.md),阴影/遮挡/色调见 [entity-lighting](entity-lighting.md),
单位与空间见 [lighting-scale-reference](lighting-scale-reference.md) / [coordinate-spaces](coordinate-spaces.md)。

## 权威源(读代码从哪进)

着色核心 `charShadeCore.glsl#shadeEntityLinear`(`shadeCharacterLinear` 留给旧参数实验室,同一份源);
mesh 路径 `CharacterLitSprite.ts`、filter 路径 `CharacterShadingFilter.ts`(probe 查表 GLSL 住这里);
载荷 / probe / 体素卷生命周期与受光倍率 `CharacterLightingSystem.ts`、`src/data/lightFactors.ts`;
运行时读哪些文件 `lightingPayloadFiles.ts`;灯的闭式解 `lighting/lightingCore.glsl`;
法线图集离线端 `bake_normal_atlas.py`。路径分流点 `Game.litShaderProvider`。

## 硬契约(违反即 bug 的机制约束)

- **受光倍率逐场景 / 时段,角色与粒子各一组**(`lighting.lightFactors.character / particles`:
  间接 / 直接 / 总倍率 + `eChroma`)。反射光 = `linear(color) × 总 × (间接E×间接 + 直接E×直接)`。
  作者真值在场景文件(主编辑器表单 / 时段表单);F2 改的是**运行时实时值**,经光照同步通道进编辑器
  工作副本,`Save All` 才落盘,不进玩家存档。缺项等价取旧式 `间接=giStrength、直接=1、总=2^β/π`,
  **显式配置优先**——重烘出来的新 β / eChroma 不得覆盖场景已保存的倍率。粒子只借场景采样资源,
  角色的曝光 / 色度 / 测试太阳不串到粒子;粒子效果自己只多乘 `appearance.lightGain`。
- **运行时压暗(envDim)乘在总倍率上**,不碰间接/直接配比与色度;必须与背景那份同值,由 `Game`
  一个入口同时推(见 [scene-lighting](scene-lighting.md) 的压暗一条)。
- **灯必须来自场景那次打包的结果**,同一份 `PackedLights` + 同一个 `wuPerQUnit`;角色侧再打一遍
  = 第二个真相源,不报错。实体灯循环 `ENTITY_SCENE_LIGHTS_GLSL` 是角色 mesh 与粒子受光**共用的同一段**
  (测试钉着粒子侧不许再写 `lc*Light`)。
- **光照在世界空间算,查表按载荷的基**(铁律 0 及其边界,见 [coordinate-spaces](coordinate-spaces.md)):
  灯循环直接用法线图的 `n`——角色图集法线**本来就是世界向量**(直立 quad,中性法线 = 世界水平),
  再乘一次 R 就是把人整体仰起一个俯角。probe / 体素 / skyao 的 SH 载荷**方向基是 q**,查表键必须是
  `nQ = Rᵀ·n`——这是索引,不是拿 q 量去算光。
  ⚠ 2026-08-31 曾按"两处都原样用 n"改过一轮,当日被审计钉为回归并回滚:原样传比 `Rᵀ` 传**暗约两成**;
  当时"看起来仍匹配"是两次测量的地面参照换了、不可比。**别再翻第三次**,两侧口径由
  `worldSpaceShading.test.ts` 机械锁死。
  踩过的混用:N 在 q、L 在 M-world,45° 场景里正面 N·L 应为 0.707 算出 0——身体不亮、脚下地面照常亮。
- **重放 / 缓存路径不许吃缺省参数**:进场景真实时序是灯先到、基后到,**每次进场景都走重放**;
  标定尺度在那条路上落回缺省就是"灯亮、地亮、人不亮"(通用形状见 lighting-scale-reference 坑⑤)。
- **显示变换与背景同一组参数**(`applyDisplay`),少这条 ev 一开就"背景很亮、角色漆黑"。
  有场景对照的调试档同样要过这条显示链,纯读数的取证子档才刻意保持裸值。
- **E 只出明暗,角色保留自己的颜色**:sprite 像素是美术着色后的 color 不是 albedo,带场景色的 E
  去乘 = 二次着色;反向"把角色往场景色拟合"会幂次过冲,已整体拆除,勿重造。
- **着色核心单一真相源**:只改 `charShadeCore.glsl`,禁止在任一 shader 内联重写。
- **法线与 color 必须用同一个顶点 UV 采样**。从世界坐标反推 UV 一旦逐帧驱动缺席(过场态整段跳过)
  就全身采到边缘列:通体单色 / 镜像换色 / 闪烁。镜像由顶点行列式正负判,不引 uniform。
- **法线图集格边界与运行时浮点 stride 逐字对齐**(`round(k*w/cols)`,不是整数截断),误差随帧序号
  累积 ⇒ 静止也逐帧闪。改 `cols/rows/downscale` 或换图集**必须重烘**;法线纹理**逐帧跟当前图集**。
  法线只离线烘、运行时只加载,缺图走平面法线降级,**禁止加载期现场烘焙**(主线程焊死数秒)。
- **lit quad 的世界坐标由 CPU 每帧喂 local→世界仿射,不许从 screen 反推**(滤镜容器会让反推整体平移,
  见 [pixi-v8-traps](pixi-v8-traps.md));且**必须含外层实体容器**(`SpriteEntity.setLitParentTransform`)——
  「container.x/y = 世界」只对 Player 成立,Npc 的 sprite 挂在自己 container 下,漏了外层全部 NPC
  拿 (0,0) 采 probe;静态 NPC 永不换帧,错值创建时写一次就再无暴露机会。挂件同一套合成。
- **载荷分级降级**:版本过低直接禁用;背景哈希失配**不整份禁用**——几何项照用、光照项(probe/体素)
  照常装载但已是旧画面的光,只标 stale 并在 dev 大声报。**旁挂文件缺席必抛**(`fetchPayloadBytes`):
  图集 / `probes_valid.bin` / `ground_d.png` 取不到或回落成 HTML 时整份作废并出声——曾把 404 正文当图集吃,
  偶数字节补零成全黑剪影、奇数字节 RangeError 整份作废,28 个场景黑一轮而零报错。
  进场景只拉 `shading.mode` 那一张图集,缺省 mode 3(八面体)。
- **重画背景 = 必须重烘那张背景的整套载荷**。重画是内容侧日常操作,既有门几乎都抓不到
  (素材审计只查存在、打包照抽、真跑不 404),只有数据校验的烘焙条目与发行前新鲜度门会说话
  (见 [build-pipeline](build-pipeline.md))。
- **时段换原画 = 换一整套烘焙目录,夜的 probe 单独烘**。时段原画没烘且变体没换深度图时,运行时只借
  主背景的**几何项**(`loadGeometryOnly`),probe 不借——`active === false`,角色退 EntityLightingFilter 色调融入。
- **体素卷永不预载**,开 RT 才拉、切离即卸。换卷 / 换 probe 图集**先重挂滤镜再销毁旧纹理**
  (反了见 pixi-v8-traps)。
- **`charLights` 组(实体灯 + 显示变换)换场景时归零**(`Game` 的 lightingUnloader):装载器只在场景**有**
  lighting 块时重写它,不清的话下个场景接着用上一个场景的灯与 `wuPerQUnit`(2026-09-12 实测)。

## 已停用:统一角色路径(留码不删,别当缺陷重报)

`UNIFIED_CHAR_PATH_ENABLED = false` 关死整条路:它的环境项是"合成天光 × 天穹可见性",
原画不再被重打光后不对应任何东西。连带无消费者:`UnifiedCharacterShader.ts` / `UnifiedCharacterLighting.ts`、
`GiBouncePass`、3D 天穹可见性网格、`radianceScale` / `characterShape` / `giGain`、`lighting.placeholder`,
以及**角色侧的雾**(雾只在背景,开雾场景角色"贴"在雾前面)。重启前必须读回来的三条:
- `radianceScale` **不许手填**:它描述原画性质,缺省 = 烘焙反解的场景反射率 ÷ 角色图集实测反射率
  (角色基准 0.0381);通用的「典型反射率 0.25」在这套暗色美术上差 6.5 倍。
- **两条路径同名参数含义不同,禁止互相继承**:旧载荷的 `flatten`/`bulge` 喂进按 N·L 的新模型 = 法线压平。
- 3D 天穹网格必须 `texelFetch` 手写三线性(硬件过滤跨切片串色);`lcSkyLight` 已含半球项,调用方别再乘。

## 已知坑

- **F2「测试太阳」是在 q 里算 N·L 的**(`dot(nQ, uSunDirQ)`,方向由 q 里的方位/仰角拼,仰角相对屏幕上
  而非世界上)——违反铁律 0 的现存欠账,缺省关;别把它当"太阳项在 q 是设计"的证据引用。
- **角色 / 粒子"整场偏黑"先查载荷状态,别先查 shader**:dev 控制台有 `照明烘焙过期` / 该时段走几何-only /
  β 或倍率缺项落回旧式,都是这个症状。批量烘焙缺省 β=0 的载荷角色就是黑剪影;`shading.beta` 当初是补偿
  错误采样位置抬起来的,**别把已落盘的 β 当标定结论引用**。对齐角色亮度的度量:
  M =(角色渲染亮度 ÷ 贴图亮度)÷(脚边朝上地面渲染亮度 ÷ albedo),同一张贴图多处取中位;8 位读回下
  要在接近目标的倍率上反推。原画里**画出来**的光池处角色仍是剪影,调倍率救不了。
- **dev 下按 `r.ok` 判文件在不在会被 SPA 回退骗**:vite 对缺失文件回 200+HTML。载荷目录探测以"能否解析"
  为准(`fetchPayloadMeta`),新写的装载处照此办。
- `bulge` 只偏移采样点深度、**不改法线**(法线离线从 alpha 烘死)——一个控件两种未同步的语义。
- 用调试面板改世界尺寸后,系统内的场景世界宽高不跟着更新(只在载荷装载时写一次),脚点会漂。
- 法线图这类「alpha 当数据用」的纹理必须走非默认装载通道(见 pixi-v8-traps 预乘一条)。

## 怎么验证

`npx vitest run src/rendering/lighting/worldSpaceShading.test.ts`(两侧查表基、粒子共用灯循环)。
像素取证用 `renderer.extract.pixels` 逐通道对账(mesh 路径 extract 拿到真着色,filter 路径不是);
位置类取证必须整舞台抽取、页内别手动喂帧参数、GPU 真值用 `gl.getUniform`——配方与陷阱全在
[headless-visual-verification](../recipes/headless-visual-verification.md)。
健康判据:法线可视化下**两朝向整体色调对称、帧均值≈中性**,静止连拍纹丝不动;
旧口径「两朝向 R 互补即正确」只在被预乘污染的场里成立,勿再引用。
