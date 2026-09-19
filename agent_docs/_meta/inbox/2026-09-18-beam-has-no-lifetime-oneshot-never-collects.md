---
target: vfx-system
date: 2026-09-18
session: leifu-skill
---

# 光柱没有寿命 ⇒ 带光柱的效果用 `playVfx({oneShot})` 永远不收尸

**现实**：`VfxInstanceSim.finished` 要求 `beamsDark`（光柱 active=false 且 fade 归零），
而光柱**只有开关、没有寿命**——只在 `sim.start()` 置 active、`sim.stop()` 清 active，
没有任何按时间自灭的路径。于是一个挂了 `beams` 的效果用 `playVfx({ oneShot: true })` 放出来，
粒子放完了也永远 `finished === false`，那道柱子一直戳在场上，直到 `stopVfx*` 或切场景。

**库里怎么写的**：`vfx-system` 机制卡讲了光柱的形状、画法与作者面，没提它与一次性实例收尸的关系；
`oneShot` 那一侧的注释只说"效果放完就自己收"。两边都没错，合起来才是坑。

**代价**：2026-09-18 做符纸雷击时踩到。绕法是放完显式 `stopVfxSoft(vid)`（软停让光柱按自己的
`fadeOut` 淡掉、在飞的粒子飞完再收；硬 `stopVfx` 对临时实例是当场删除，整道雷凭空消失）。
⚠ 软停收尸判的是 `liveCount === 0` 而**不是** `beamsDark`，所以光柱的 `fadeOut` 必须短于
最后一颗粒子的寿命，否则柱子会在淡到一半时被连实例一起删掉（看着就是"啪"一下没了）。
落地见 `Game.strikeThreat` 里那段注释。
