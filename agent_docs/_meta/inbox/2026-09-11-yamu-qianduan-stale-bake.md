---
target: scene-lighting
date: 2026-09-11
session: vfx-system
---

现象: 崖墓前段一进场就刷 `照明烘焙过期(bake de6cb1f32d6a vs bg 94560a803c3d)`，
运行时按设计**只丢光照项(probe/体素)、留几何项**，于是该场景所有走 probe 的东西都近乎全黑——
本会话的水滴粒子实测只有 23/255，同一块岩壁背景 68/255；场景 `lighting.lights` 也是空的，
连一盏加性灯都补不上。
证据: 本会话 `?mode=dev` 进 崖墓前段 的控制台（每次 scene:ready 复读一遍，带 `[load-failure]` 前缀）；
像素 A/B 见 vfx-system.md「受光那条路只有漫反射」一条。
建议: 去角色照明实验室按现背景重烘一次并重新导出；在那之前，任何"崖墓前段角色/粒子太黑"的
报告都不是渲染 bug。顺带值得在 scene-lighting 里写明「烘焙过期 = 静默降级成几何-only，
症状是整场吃 probe 的东西一起变黑」，现在只有一行 ERROR，没说清后果。
