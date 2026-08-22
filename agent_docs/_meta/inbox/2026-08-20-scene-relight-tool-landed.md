---
target: asset-pipeline-norms
date: 2026-08-20
session: 新建场景重打光工具(白天背景 → 任意时段/天气变体)
---

# 新工具 tools/scene_relight 已落地,待收编入库

- **是什么**:确定性场景背景重打光工作台(:5317)。复用 char-lighting lab 导出的
  raw_depth_rg + depthConfig 做 depth 感知重打光(半球环境+定向光+屏幕空间高度场
  阴影+发光 mask 灯火+深度雾+湿地+调色),预设 key 对齐 dayNight.phases(辰/午/暮/夜)
  加天气组合;产物 `background_relight_<预设>.png` 原子写入 runtime 场景目录,
  覆盖前自动备份。逐场景参数/发光 mask 进 git(out/,仅 backup/ ignore)。
  技术选型有一份 2024-2026 relighting 调研支撑:扩散直出不可 ship(风格漂/许可证/
  复现性),业界 2D 游戏 day-night 均为确定性资产管线;详见工具 README。
- **与库内认知的缝**:①`SceneTimeVariant.timeVariants` 只有类型声明,运行时**没有
  消费逻辑**,变体图接线前需先做换图消费(feature-iteration);②角色照明 probe 仍按
  白天背景烘,夜景变体下人物会偏亮,需要 char-lighting lab 支持按变体重烘/多套导出;
  ③码头白天现有的演示发光 mask 是 agent 猜的灯位,正式用前美术要重刷。
- **顺带复证**:2026-08-19 那条「pytest 收尾挂死 = cacheprovider 万次重试」在
  `pytest tools/scene_relight/tests` 上原样复现,`-p no:cacheprovider` 后 2.5s 干净跑完。
