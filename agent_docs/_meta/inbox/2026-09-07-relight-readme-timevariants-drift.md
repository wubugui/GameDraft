---
target: scene-lighting
date: 2026-09-07
session: 重打光工具文档偏差
---

来源：tools/scene_relight/README.md「产物与接线」仍称 timeVariants 没有运行时换图消费。
现实：src/utils/sceneAppearance.ts 的 resolveSceneAppearance 已解析当前时段背景，scene-lighting 机制卡也明确其为现行路径。
建议：后续文档治理修正 README 的旧接线说明；本次仅记录偏差，不修改实现。
