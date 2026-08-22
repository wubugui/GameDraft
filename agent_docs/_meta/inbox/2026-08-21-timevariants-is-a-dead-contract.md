---
kind: deviation
date: 2026-08-21
target: scene-radiance-restoration-pipeline
---

- **说的**：`SceneData.timeVariants`（`src/data/types.ts:516`）是「日夜换背景图」的数据契约，
  `tools/scene_relight/store.py:101` 的导出路径还在生产它的 snippet（有测试断言）。
- **实际**：`src/**` 里**没有任何代码读它**——只有 types.ts 的声明与注释。
  今天清掉 `test_room_b` 那条键名非法的脏数据（`"night"` 不在 辰/午/暮/夜）之后，
  全仓 scene JSON 里 `timeVariants` **归零**。也就是说：工具在产一份没人消费的数据，
  而 validate-data 对它一个字都不报（`validator.py:1359` 明确写了刻意不校验）。
- **背景**：统一光影已经用「运行时重打光」取代了「换一张烘好的夜景图」这条路线，
  所以它是被**取代**而不是被遗忘。但取代得不干净：契约、导出、测试三处还都在。
- **建议**：要么把 `timeVariants` 连同 `store.py` 的导出一起下线（它已无消费者），
  要么在 types.ts 上标 `@deprecated` 并说明"已被统一光影取代"，免得下一个人照着它做夜景。
