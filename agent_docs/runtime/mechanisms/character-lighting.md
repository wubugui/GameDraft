---
id: character-lighting
title: 角色逐像素照明(probe·法线·着色核心)
domain: runtime
type: mechanism
summary: 两条路径——统一光影(角色与场景吃同一份 S,吃 3D 天穹遮蔽)优先,没配 lighting 的场景回落旧 probe;着色核心各自单一 GLSL 源;法线必须与 color 同 UV 采样、格边界与运行时 stride 对齐
status: active
authority:
  - src/rendering/lighting/UnifiedCharacterShader.ts
  - src/rendering/lighting/lightingCore.glsl
  - src/rendering/lighting/lightPacking.ts
  - src/core/UnifiedCharacterLighting.ts
  - src/rendering/charShadeCore.glsl
  - src/rendering/CharacterLitSprite.ts#LitSpriteQuad
  - src/rendering/CharacterShadingFilter.ts
  - src/core/CharacterLightingSystem.ts
  - src/rendering/spriteNormalAtlas.ts
  - tools/character_lighting_lab/pipeline.py
  - tools/animation_pipeline/bake_normal_atlas.py
triggers:
  paths: ["src/rendering/lighting/**", "src/core/UnifiedCharacterLighting.ts", "src/rendering/charShadeCore.glsl", "src/rendering/CharacterLitSprite.ts", "src/rendering/CharacterShadingFilter.ts", "src/rendering/spriteNormalAtlas.ts", "src/core/CharacterLightingSystem.ts", "tools/character_lighting_lab/**", "tools/animation_pipeline/bake_normal_atlas.py"]
  topics: [角色照明, probe, 法线图集, 伪世界照明, CHAR_FS, 体素卷, 融入场景, 统一光影, 天穹可见性, radianceScale, 烘焙 GI, charGi, 比例基底]
last_governed: 2026-08-23
---

## 是什么(一句话)

按角色法线逐像素给玩家 / NPC / 挂件打光。**现有两条路径,按场景是否配了 `lighting` 块分流**:

| | 统一光影(2026-08-20 起,优先) | 旧 probe(回落) |
|---|---|---|
| 光从哪来 | 与场景背景**同一份** `SceneLightingDef`(同一次 `packLights`) | 离线烘死的 probe 辐射场 E |
| 遮蔽 | 3D 天穹可见性网格三线性(与场景逐像素传输基 **同源同 march**) | probe 里已经烘进去了 |
| 场景光变了角色跟不跟 | **跟**(实时) | **不跟**(烘死的) |
| shader | `lighting/UnifiedCharacterShader.ts` + `lightingCore.glsl` | `charShadeCore.glsl` |

**2026-08-23 起角色还吃场景的烘焙 GI**(`sky_sh_grid.bin` 的 5..7 通道,与场景那份
是同一次 final gather、起点换成网格点)。这不是可选装饰:未重打光的场景 `sky`/`lights`
都是 0,场景本体靠的就是那份 GI —— `charGi` 调到 0 角色会**全黑**。
详见 [pseudo-world-final-gather](../decisions/2026-08-23-pseudo-world-final-gather.md)。

分流点是 `Game.litShaderProvider`:`UnifiedCharacterLighting.createShader()` 返回非 null 就走新路,
否则回落 `CharacterLightingSystem.createEntityLitShader`。旧场景零影响。

场景侧的阴影与遮挡见 [entity-lighting](entity-lighting.md),烘焙管线的设计取舍见
[2026-07-21-scene-radiance-restoration-pipeline](../decisions/2026-07-21-scene-radiance-restoration-pipeline.md)。

## 权威源(读代码从哪进)

新路:`lighting/UnifiedCharacterShader.ts`(角色 mesh shader)+ `lighting/lightingCore.glsl`
(`S(L,几何)` 的唯一实现,场景与角色共用)+ `core/UnifiedCharacterLighting.ts`(协调者)。
旧路:`charShadeCore.glsl`;载荷与 probe / 体素卷生命周期 `CharacterLightingSystem.ts`;
离线端 `tools/character_lighting_lab/`(烘焙+调参预览)与 `bake_normal_atlas.py`(法线图集)。
统一光影的几何场与照明由 `tools/scene_relight/bake_gbuffer.py` 烘(`lighting3/`):
伪世界 final gather 出辐照度 `E`,把原画拆成 `base·E + emissive`(恒等式);
天穹传输是同一趟积分的另一个投影。`lighting2/` 是上一代,已不进渲染路径。

## 硬契约(违反即 bug)

### 统一光影路径

- **角色与场景吃的必须是同一份数据,不是"两处写得一样的代码"**。灯来自
  `SceneLightingPass.packedLights` 的**同一次** `packLights` 调用;天穹可见性来自
  与逐像素 `skyvis.png` 同方向、同 march 烘出来的 3D 网格;显示变换来自同一个 `def.display`。
  任何一处改成"角色自己再算一遍"就等于开了第二个真相源,「角色与场景明暗一致」立刻
  失去构造性保证(制作人原话:「角色最重要的是要符合场景明暗,只要是要吃天光遮蔽」)。
- **`radianceScale` 不许手填**,理由与 `day.hemi` 同源:它描述的是这张原画的性质,
  不是美术意图。缺省由烘焙期反解的场景反射率 ÷ 角色图集实测反射率算出
  (`CHARACTER_ALBEDO_REFERENCE = 0.0381`,**实测**全部 109 张图集 3081 万像素的中位线性亮度)。
  ⚠ 通用图形学的「典型反射率 0.25」对这套暗色民俗恐怖美术**差 6.5 倍**,照它填角色会
  系统性偏暗到 1/6.5,而且怎么调灯都救不回来 —— 错的是尺度不是光。
- **3D 天穹可见性网格必须 `texelFetch` 手写三线性**,不能用硬件线性过滤:
  网格按 Z 切片横向平铺成 2D,硬件过滤会在切片接缝上把相邻 Z 层混进来。
- **`lcSkyLight` 内部已含半球项,调用方不要再乘一遍**(踩过:整场景暗到 0.6 倍)。
- 顶点着色器与 `CharacterLitSprite` 的 VERT **逐字同式**。差半个像素就会在切换路径时看到跳变。
- ⚠ **两条路径的同名参数含义不同，禁止互相继承**。旧 probe 载荷
  （`lighting/lighting.json` 的 `shading` 块）里有 `flatten` / `bulge`，那是实验室为
  **旧着色模型**调的：那边 `flatten` 只是让 probe 的 SH 辐照更均匀（因为 sprite 像素本就
  画好了明暗，再按法线调制一次会二次着色）。新模型里法线直接进**每盏灯的 N·L**，
  `flatten = 1` ⇒ 左边的灯和右边的灯算出来一模一样、背后的灯完全不亮 —— 方向性整个消失。
  2026-08-21 实测：雾津街头的旧载荷带 `flatten: 1.0`，被原样传进新 shader，
  角色法线调试视图是一片扁平橄榄色 (128,128,0)、全身零形体明暗。
  新路径的形体参数在 `SceneLightingDef.characterShape`（缺省 flatten=0 / bulge=0.22），
  由 `applyParams` 写；`syncFrame` **只喂位姿与 AO**。
- **GI 的定义是制作人给的**（2026-08-20）：「角色如何被 relighting 后的场景照亮，
  **不需要真的多次反弹**」。实现分三级：离线烘命中图（几何项，与光无关）→
  脏时 `GiBouncePass` 查当前重打光结果 → 角色一次三线性。
  · 命中图与法线 / 天穹可见性同类：摆灯、调参、推进时刻**都不用重烘**。
  · 灯体排除判的是**自发光占比**（辐射场 alpha，0..1）不是绝对亮度——
    绝对阈值会随灯的强度漂，灯一亮被判成"灯体"的区域跟着变大，把该采的光挡掉。
  · 反弹项是**各向同性**近似（16 方向平均，不按 N·d 加权）。它给的是"周围有多亮"，
    方向感是解析灯的活；间接光本就低频，这个近似看不出来。
- ⚠ **`extract.pixels` 读不了浮点 RT**（RGBA16F 取出来全是 0，且不报错）。
  验辐射场 / 反弹网格只能走**正常渲染路径**（切调试视图 + 取屏），不能直接 extract。
  本轮两次差点据此得出"这一级没在跑"的错误结论。

### 两条路径共同

- **着色核心单一真相源**:只改 `charShadeCore.glsl#shadeCharacterLinear`(运行时与实验室
  各自注入同一份字符串),**禁止在任一 shader 内联重写**。实验室是调着色参数的唯一入口,
  一漂移调出来的值到游戏里就是错的**而且不报错**;实验室预览增益是唯一允许的口径差。
- **E 只出明暗,角色保留自己的颜色**:sprite 像素是美术**着色后的 color**、不是 albedo,
  拿带场景色的 E 去乘 = 二次着色。反方向补救(在无 E 的素材域把角色往场景色拟合、再应用到
  有 E 的显示域)会幂次过冲,那条路已整体拆除,勿重造。
- **法线与 color 必须用同一个顶点 UV 采样**。从世界坐标反推 UV 一旦逐帧驱动缺席
  (实测过场态整段跳过)就全身采到边缘列:通体单色 / 镜像换色 / 闪烁。
  镜像由顶点行列式正负判(几何自身事实),不引 uniform。
- **法线图集的格边界必须与运行时的浮点 stride 逐字对齐**(`round(k*w/cols)`,不是整数截断
  铺放):误差随帧序号线性累积 → 静止角色也逐帧闪、左右朝向法线明显不同。改 `cols/rows/
  downscale` 或换图集后**必须重烘**。法线纹理还得**逐帧跟当前图集**——实体会换动画包,
  绑一次就成了"新坐标查旧图"。
- 法线只离线烘、运行时只加载,缺图走平面法线降级;**禁止加载期现场烘焙**(主线程焊死数秒)。
- **probe 载荷低于当前版本直接禁用**:E 现为导出即固化的单块,运行时不再组合分账;
  实验室 viewer 读的是分账缓存实时组合——**两条数据路径,别互相推断**。
- **体素卷永不预载**,开 RT 才拉、切离即卸。换卷 / 换 probe 图集纹理时**先重挂滤镜再销毁
  旧纹理**,顺序反了会永久烧毁滤镜(见 [pixi-v8-traps](pixi-v8-traps.md))。

## 已知坑

- `bulge` 旋钮只偏移采样点深度、**不改法线**(法线是离线从 alpha 烘死的固定鼓包 profile)
  ——一个控件承诺了两种未同步的语义。
- 烘焙把落在实体内的 probe 原点吸附到最近自由体素,运行时却按规则格点插值、载荷不带真实
  probe 位置——两套位置语义并存。
- 实验室的「场景EV」只进参数与 manifest、**不进烘焙计算路径**,调它不改辐射;
  与 2026-07-21 决策卡的还原式不符,属实现缺口。
- 用调试面板改世界尺寸后,系统内的场景世界宽高不跟着更新(只在载荷装载时写一次),脚点会漂。
- 法线图这类**「alpha 当数据用」的纹理**必须走非默认装载通道,否则解码期就被预乘毁掉
  (见 [pixi-v8-traps](pixi-v8-traps.md))。

## 怎么验证

`renderer.extract.pixels` 逐通道对账(mesh 路径 extract 拿到的才是真着色像素,filter 路径不是)。
健康判据 = 法线可视化下**两朝向整体色调对称、帧均值≈中性**;旧口径「两朝向 R 互补即正确」
只在被预乘污染的场里成立,**勿再引用**。静止连拍多帧应纹丝不动。画面取证走
[headless-visual-verification](../recipes/headless-visual-verification.md)。
