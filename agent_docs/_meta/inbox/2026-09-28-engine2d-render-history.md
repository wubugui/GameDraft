文档：scene-hierarchy 旧卡称 setActive(false) 跳过变换准备。
现实：03ca35a5 起为对齐 Pixi 的下一帧剔除，隐藏子树仍更新变换；45e722f8 将剔除历史与绘制临时矩阵分开。
处理：本轮已同步 scene-hierarchy 与 engine2d 卡；行为仍须以终版 A/B 和性能验收为准，不能沿用旧提交的通过结果。
