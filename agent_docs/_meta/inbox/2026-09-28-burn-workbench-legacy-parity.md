现象：burn-workbench 卡把迁移后的 B 游戏双滤镜当旧工具像素参照，并用 KNOWN 接受 S7 留纸；独立 master BurnGL/B 工具 A/B 实际燃尽差 20.12%。
权威：master 86571649 tools/burn_workbench/viewer/render.js 为直通图采样后单 pass 材质+发光；burn_ab_capture_01 原 EXIT1 保留，工具修复不得改游戏共享滤镜。
修订：卡与工具测试改为固定旧工具 oracle，保留完整旧 A/B 验收；单 pass、原 CSS uScreen、独占直通贴图和生命周期由 tools/burn_workbench/gpu 回归覆盖。
