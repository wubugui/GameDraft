---
target: character-lighting
date: 2026-09-12
session: 粒子遮挡与受光修复（审查 → 按方案实施）
---

现象: ① `charLights` 组(角色 / 粒子的实体灯 + 显示变换)只在场景**有** lighting 块时由装载器重写,换进没配 lighting 的场景会接着用上一个场景的灯与 wuPerQUnit;② `CharacterLightingSystem.load` 的"扁平旧布局"回落在 dev 下从没生效——vite SPA 回退给缺失的 `lighting.json` 回 200+HTML,`r.ok` 为真就锁定了那个目录,随后 `json()` 抛错整份放弃。
证据: ① 义庄 → 崖墓前段后 `uSceneLightCount` 仍为 1、`uSMWuPerQUnit` 仍为 220(崖墓前段应为 309);已在 lightingUnloader 里 `applyDisplay(null) + applyLights(null)`,切回义庄灯照常回来。② 崖墓前段「夜」时 `loadedBakeBase` 指向不存在的 `lighting/background_night`、resources 为 null;现改为 `fetchPayloadMeta` 以"能否解析"为准逐个目录试。
建议: character-lighting 卡已补这两条;凡"按 `r.ok` 判文件在不在"的装载处在 dev 下都可能被 SPA 回退骗,值得统一扫一遍。
