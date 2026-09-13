---
target: vfx-system
date: 2026-09-12
session: 跑马梁场景风 / 纸钱薄片
---

现象: 卡里把"受光粒子是黑疙瘩"归因于材质缺镜面/散射项;但在跑马梁,朗伯白纸(反照率≈0.8)走受光路径同样画成深灰(普通 billboard 与新薄片 program 一样),而原画里同款纸钱亮度≈200/255——更像 probe 受光与原画亮度的整体尺度对不上,不只是材质缺项。
证据: 跑马梁 ?mode=dev,纸钱效果 lit:true 与 lit:false 并排截图;去掉 plate 后的 lit billboard 同样偏暗;frameLit/sceneLit uniform 无异常(uMode 3、uGiStrength 1)。
建议: 查受光粒子(及角色)照度与原画 albedo 烘焙的尺度关系;查清前浅色材质一律 lit:false + tint。
