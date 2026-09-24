---
target: vfx-system
date: 2026-09-23
session: 游戏关卡与演出问题修复
---

现象: 临时实例要等效果 JSON + 贴图装完才画，落雷雷柱发车 210 ms（游戏时钟）就软停——冷页首雷 64–68 ms 才装完（晚雷光四帧），负载高时整道不画。音频早有"脱手演出开场静默预备"，粒子没有。
证据: 新增 VfxSystem.prepareEffects + ActionRegistry performanceVfx（runActionsDetached 开场调 d.vfx.prepare）；src/core/ActionRegistryGameClock.test.ts 新用例。
建议: vfx-system / detached-performance-session 卡补一句：脱手演出开场同时预备音频与粒子（只读引用、不求条件不掷随机）；非脱手批里的 playVfx 仍是冷装载。
