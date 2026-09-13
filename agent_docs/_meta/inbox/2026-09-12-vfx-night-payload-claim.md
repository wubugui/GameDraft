---
target: vfx-system
date: 2026-09-12
session: 跑马梁场景风 / 纸钱薄片
---

现象: 卡里写"时段变体现在整体没有载荷(载荷只有主背景那一份)";实际分场景:雾津街头有 lighting/background-night/,跑马梁没有 lighting/跑马梁－深夜/(夜里粒子退平面近似、草木不摆)。
证据: ls public/resources/runtime/scenes/雾津街头/lighting/ 与 跑马梁/lighting/;scene_fields 缺省按全部时段原画烘,跑马梁夜图显然没跑过。
建议: 卡里改成"逐场景看目录在不在",并给跑马梁夜图补烘(scene_fields --scene 跑马梁)。
