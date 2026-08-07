---
id: character-lighting
title: 角色逐像素照明(probe·法线·着色核心)
domain: runtime
type: mechanism
summary: 场景烘出的 E 只给角色出明暗不给颜色;着色核心是单一 GLSL 源;法线必须与 color 同 UV 采样、格边界与运行时 stride 对齐
status: active
authority:
  - src/rendering/charShadeCore.glsl
  - src/rendering/CharacterLitSprite.ts#LitSpriteQuad
  - src/rendering/CharacterShadingFilter.ts
  - src/core/CharacterLightingSystem.ts
  - src/rendering/spriteNormalAtlas.ts
  - tools/character_lighting_lab/pipeline.py
  - tools/animation_pipeline/bake_normal_atlas.py
triggers:
  paths: ["src/rendering/charShadeCore.glsl", "src/rendering/CharacterLitSprite.ts", "src/rendering/CharacterShadingFilter.ts", "src/rendering/spriteNormalAtlas.ts", "src/core/CharacterLightingSystem.ts", "tools/character_lighting_lab/**", "tools/animation_pipeline/bake_normal_atlas.py"]
  topics: [角色照明, probe, 法线图集, 伪世界照明, CHAR_FS, 体素卷, 融入场景]
last_governed: 2026-08-05
---

## 是什么(一句话)

把离线烘的场景辐射场(probe 里的入射光 E)按角色法线逐像素打到玩家 / NPC / 挂件身上;
场景侧的阴影与遮挡见 [entity-lighting](entity-lighting.md),烘焙管线的设计取舍见
[2026-07-21-scene-radiance-restoration-pipeline](../decisions/2026-07-21-scene-radiance-restoration-pipeline.md)。

## 权威源(读代码从哪进)

着色数学 `charShadeCore.glsl`;两条渲染路径(角色/挂件走 mesh、热点静态图走 filter);
载荷与 probe / 体素卷生命周期 `CharacterLightingSystem.ts`;离线端
`tools/character_lighting_lab/`(烘焙+调参预览)与 `bake_normal_atlas.py`(法线图集)。

## 硬契约(违反即 bug)

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
