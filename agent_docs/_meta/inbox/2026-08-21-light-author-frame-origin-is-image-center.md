---
target: light-authoring-gizmos
date: 2026-08-21
session: 运行时编辑模式 v1（在真实画面里摆灯）
---

现象：编辑器 `scene_editor._recompute_light_heights` 算「灯的离地高度」用的是
「把灯投影到画布、在落点采地面」，而深度图里"深度恒定的一片"在 45° 视角下**不是**
世界里的水平地面 —— 实测抬高 300 wu，估出来的地面跟着爬 150 wu，读数只剩一半且越拖越飘。

证据：运行时侧已改对（`src/authoring/lightSpace.ts` 的 `groundBelow`，解
`world(q).x/z == 灯的 x/z ∧ q.z == ground(q.xy)`，**迭代必须带阻尼** —— 真水平地面上
`∂d/∂qy` 恰好是 1，裸迭代在两个值之间震荡、偶数次正好跳回出发点，有单测）；
Python 侧这一份没跟上。只影响 UI 读数与「在画布上定位」的输入，不进数据契约。

建议：把 Python 侧换成同一条解法，或直接向运行时要这个读数。
（本记录原有的另一半"灯的作者面原点在画面中心"已于 2026-08-31 落进
`runtime/mechanisms/coordinate-spaces.md` 的空间总表，不再重复。）
