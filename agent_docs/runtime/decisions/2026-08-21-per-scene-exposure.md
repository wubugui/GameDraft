---
id: per-scene-exposure
title: 曝光逐场景独立调,不做全局对齐
domain: runtime
type: decision
summary: display（ev/tonemap/对比/饱和/lift）留在场景 JSON 里逐场景调;不把 albedo 标定接进背景、不提全局曝光层——精度不是这个项目要的东西
status: active
last_governed: 2026-08-21
---

## 拍板

**`SceneLightingDef.display` 逐场景独立调,就这样。** 制作人 2026-08-21:

> 「算了别搞了,不需要搞的这么精准,只要每个场景能独立调节就行了」

## 被否掉的是什么

同一天早些时候制作人指出过曝光不统一的问题:

> 「ev 这个是随便调的?曝光随便调,都不对齐不统一」

> ⚠ **2026-08-23 更新**:下面那三条技术事实里,`meta.albedo.albedo_mean` 与
> `radianceScale` 这两个名字**已经不存在了**(见
> [pseudo-world-final-gather](2026-08-23-pseudo-world-final-gather.md))。
> 现在角色的标定走 `charRefIntensity`(由 `base.median` 推出),背景与角色共用
> `base·E` 这一条式子。**结论没变**:每张画自带的曝光差异仍在,仍然逐场景用
> `display.ev` 补,仍然不提全局曝光层。改的只是这些数叫什么、从哪来。

当时查出来的技术事实(名字已变,量级仍成立):

1. 烘焙期已经反解了每张原画的平均反射率 `meta.albedo.albedo_mean`
   (先去霾再除 `sDay`),它跨 28 个场景差 **448 倍** —— 那就是"每张画自带的曝光"。
2. 这个数**只接到角色**(`SceneLightingSystem.radianceScale = albedo_mean / 0.0381`),
   **背景那条没用它**,走的是裸的 `原画 × S_new/S_day`。
3. 所以背景的绝对亮度随原画浮动,而唯一在补偿它的东西就是逐场景手挑的 `display.ev`。

"修法"本来是:把 albedo 标定也接进背景 → 辐射场变成场景无关的绝对量 →
`display.ev` 升格为全局相机属性。**这条路被明确否掉了。**

## 为什么不做(理由归属)

制作人的判断是**精度不值这个成本**。这是产品决定不是技术决定 —— 上面三条技术事实
没有被推翻,只是不作为行动依据。

代价要说清楚,免得将来有人以为它是免费的:

- 场景之间的亮度**没有可比性**;从 A 走到 B 会有亮度跳变,幅度取决于两张画的 ev 差。
- 灯的 `intensity` 在不同场景里**不代表同一个物理量** —— 同一个 3.0 在两张画上亮度不同。
- 每个新场景都要**手调一次 ev**,没有可继承的基准。

这些是**已知且接受**的,不要再当 bug 报。

## 边界:什么仍然是 bug

本决定只覆盖 `display` 这一块。下面这些**不在豁免范围**,发现了照样修:

- `radianceScale` / `day_hemi` / `albedo` 这些**烘焙期反解的标定量**算错 ——
  它们描述的是原画的性质,不是美术意图,错了就是错了(见 `lighting-scale-reference`)。
- 角色与背景在**同一个场景内**对不上 —— 那是 `radianceScale` 的活,与本决定无关。
- 拿一个场景的 `display` 抄到另一个场景当"起点"**不算对齐**,只是省事;
  抄完必须重调,否则就是本决定明确接受的那个代价在咬人。

## 相关

- 坐标与单位:[[coordinate-spaces]]
- 光照参数的空间与单位:[[lighting-scale-reference]]
