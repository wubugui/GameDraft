---
id: scene-foreground-layers
title: 场景前景图层(蒙版 + 接地线 · 逐像素顶替深度图 · 被挡画虚影)
domain: runtime
type: mechanism
summary: 深度遮挡对细长前景(树干、枝条、檐角、栏杆)永远补不准,前景层在屏幕空间补:一层 = 蒙版 + 接地线(接地点或接地折线),蒙版里每个像素当成立在接地线上、朝相机的直立面,按与角色直立 quad 同一个深度梯度现算深度,**顶替深度图**参与遮挡——逐像素判,站位 / 压着的部位不同答案就不同、多个人各判各的,被挡部分与深度遮挡同一个虚影系数(制作人 2026-09-27 刻意接受虚影);不重画任何背景像素、不进实体排序;覆盖图(蒙版 + 外沿 + 预乘深度,跟着摆)交给三支实体滤镜与粒子,拆除先广播 null 再销毁 RT;本期只有 swayPlant 源(引用拆层一株,存原画像素点不存实例 id)
status: active
authority:
  - src/rendering/foreground/SceneForegroundLayers.ts
  - src/rendering/foreground/foregroundLayerDefs.ts
  - src/rendering/foreground/foregroundMaskGlsl.ts#FG_OCCLUSION_GLSL
  - src/rendering/backgroundSway.ts#createForegroundMask
  - src/core/SceneDepthSystem.ts#foregroundDepthModel
  - src/rendering/vfx/VfxRenderer.ts#setForegroundCoverage
  - src/core/Game.ts#buildForegroundLayers
  - src/data/types.ts#SceneForegroundLayerDef
  - tools/editor/validator.py#check_scene_foreground_layers
triggers:
  paths: ["src/rendering/foreground/**", "src/rendering/DepthOcclusionFilter.ts", "src/rendering/EntityLightingFilter.ts", "src/rendering/CharacterShadingFilter.ts", "src/rendering/vfx/vfxShaders.ts", "src/rendering/backgroundSway.ts"]
  topics: [前景层, 前景图层, foregroundLayers, 接地线, 前景遮挡, 树挡人, 人在树后, 覆盖图, 深度遮挡补不准, 虚影]
  tasks: [让人被树挡住, 加前景层, 查人画在树前面, 查树摆出前景层, 长物体一头挡一头不挡]
verified_by:
  - src/rendering/foreground/foregroundLayerDefs.test.ts
  - src/rendering/foreground/SceneForegroundLayers.test.ts
  - src/rendering/backgroundSwayForeground.test.ts
  - tools/editor/tests/test_scene_foreground_layers.py
last_governed: 2026-09-27
---

## 是什么(一句话)

制作人 2026-09-26 定:深度遮挡永远不准,边角在屏幕空间补;每张图都要前景层、不止一层。2026-09-27 改判(制作人问
"同一片蒙版,站这里不挡、站那里挡,怎么判"):不按整层排序,**逐像素**按接地线判,被挡画虚影。场景 JSON
`foregroundLayers[]`(全时段共用)。第一例:跑马梁崖边歪脖子树。

## 硬契约(违反即 bug)

- **判据是深度比较,不是画家排序**:蒙版里 `前景面深度(p) = 接地深度 + 深度梯度 × (p.y − 接地 y)`,接地深度取行走面场,
  深度梯度 = `depth_per_sy`(缺字段从 M 推,`uprightGradientFromM`)× 世界→深度图像素——与角色直立 quad **同一个式子**,
  两块直立面放在一起比才谈得上谁挡谁。滤镜里比 `前景面深度 < 脚点深度 + 直立面`,**不加**脚点偏置 / 容差 / floor 偏移
  (两边都来自同一张行走面场,没有噪声可吃;加了会在接地线后面留 30+ wu 的不挡带)。粒子拿前景面深度顶替深度图,容差照旧。
- **别退回"在实体层里重画背景像素 + 排序"**(2026-09-26 第一期做法,已拆):整层一个先后,做不到按站位 / 部位不同,
  多个人时排不出自洽次序。前景层现在不往实体层挂任何东西、不重画任何背景像素。
- **被挡 = 虚影**:实体走 `occlusionBlendFactor`(缺省 0.28),粒子走它自己的 `uOcclusionBlend`(整片藏)。制作人刻意接受虚影,
  别为了"挡实"再加一层重画。
- **覆盖图通道**(`foregroundMaskGlsl` 头注释):B = 前景面(纹素足迹取样,细枝不漏)、R = A = 外沿(再外扩 4 px,
  只关掉深度图的误挡、不判前景面——否则轮廓外一圈把人画成虚影)、G = R × 前景面深度(预乘,线性过滤后 G/R 仍对)。
  `rgba16float`、1/4 原画、多层远→近叠。取样只有一份 `FG_OCCLUSION_GLSL.fgSample`,三支滤镜与粒子都拼它。
- **蒙版按源像素查**(经位移图),与摆动的树一帧不差;网格范围按这株网格顶点**此刻真实最大位移**(8 wu 一档)铺,
  不按增益上限(白费 GPU)、不按软封顶(透视下实测超 14%,树梢摆出网格)。
- **接地**:`base` 缺省 = 该株的根(整株一个接地点,深度不随 x 变);`base.x / base.y` 覆盖;`base.line` = 接地折线
  (按 x 升序,两端外延,逐列取)——跨纵深的长物体一头挡一头不挡靠它。**存原画像素点 `source.at`,不存实例 id**。
- **所有权与拆除顺序**:覆盖图网格由 `SwayBackground` 创建登记(它销毁时一并销毁);前景层持 RT,`destroy` 先 `onCoverage(null)`
  (滤镜经 `SceneDepthSystem.setForegroundCoverage`、粒子经 `VfxRenderer.setForegroundCoverage` **当场**换绑占位)再销毁 RT。
  组装层在每一处销毁 / 换 `swayBackground`、拆光照之前先 `teardownForegroundLayers()`;行走面换了(载荷落地、地形推送)`refreshBase`。
- 没有前景层 ⇒ 各使用方开关 0、绑永不销毁的占位,逐像素与没有这套时相同。

## 已知坑

| 坑 | 症状 |
|---|---|
| 分割蒙版本身粗 | 跑马梁那棵树的蒙版把枝间一块崖顶也包进去:人站那块地后面也被判挡;雾粒子在那块地上被藏。修拆层分割 |
| 影子 / 光柱 / 雷身没接 | 地面投影、光柱、雷身仍只看深度图(与改动前一样),落在树干上的影子照旧叠画在树身上 |
| 没有行走面场的场景 | 前景面深度算不出来,前景层整层不建(出声);`swayPlant` 也要求有拆层 |
| 隐藏页取证 | 默认帧缓冲 GPU 计时拿 0,渲进离屏 RT 计时;`renderer.resolution` 可能是 2,读回坐标要乘;夜里跑马梁先 `lockHealth` |

## 怎么验证

- 单测:`verified_by` 四份(解析、接地采样、斜接地线"同脚底 y 不同 x 一挡一不挡"的纯数推演、两人各判各的、远→近次序、
  拆除顺序、三支滤镜 + 粒子同一段取样、粒子当场换绑、往返、校验器)。
- F2「粒子」页:前景层开关、覆盖图叠加(品红 = 前景面,红边 = 外沿)、覆盖图耗时;遮挡调试色(红 = 被挡)。
- 真机(2026-09-27 跑马梁夜 / 午):树后 (1330,480) 红 ~8500 px、游戏里虚影;树前 (1300,610) 红 0;同一帧树后玩家红、树干前 NPC 蓝;
  临时斜接地线 (1150,480)→(1500,560)、脚底 y 520:x 1260 全蓝、x 1400 压着树冠的上半身红;阵风里覆盖图跟着树变形;
  覆盖图 GPU 0.14 ms(清屏 0.04 + 绘制 0.10,有提前结束)。
