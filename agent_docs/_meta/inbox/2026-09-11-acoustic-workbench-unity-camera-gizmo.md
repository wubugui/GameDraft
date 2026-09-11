---
target: acoustic-workbench
date: 2026-09-11
session: 声学工作台 3D 画布改成 Unity 场景视图方案（对齐轨迹工作台）
---

现象: 卡里「坐标」一节仍写轨迹工作台 `common.js`「大概率同病（右手 lookAt）」，实际轨迹侧 2026-09-10 已改左手系并钉了 S11；本次声学侧相机基 / gizmo / 坐标架也整套照搬轨迹侧，两边现在是同一套，已在卡内就地改正并补了 S4 / S4c 判据说明。
证据: `tools/trajectory_workbench/viewer/common.js` lookAt 注释；`tools/acoustic_workbench/viewer/view3d.js` 文件头；`--selftest` 83/83、变异 `_right` 三条相机判据变红（本会话）。
建议: 两个工作台的 3D 交互如今是同一份手势表，考虑抽一张跨工具的「自写 3D 画布交互规范」卡（相机基 / gizmo 字段映射 / 自检六类判据 / `_up` 命名坑），两张工具卡各引一行，免得下次再各写一遍。
