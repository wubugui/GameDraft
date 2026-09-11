---
target: scene-acoustics
date: 2026-09-08
session: 声学工作台（3D 展开 · 游戏只做预览器）
---

现象: 设计稿《声学系统设计》§三写的「入口甲 = 游戏内 F2 就地摆、入口乙 = 俯视图画布工作台、双向同步」被制作人整个改了——作者面只剩独立的 3D 工作台（场景按深度展开、像 Unity 那样操作），游戏 F2 只留状态与试听；声学坐标系从「米 + 屏幕平面 + anchor/wuPerMeter」换成「M-world wu + 全局距离缩放」（所有距离含耳高一律缩放）；一个空间可强绑任何场景但逻辑上一份几何一个空间。另外照明实验室 `pipeline.py` 以脚本方式跑（GUI 也是这么起它的）在 probes 阶段炸在 `from .dering import` 相对 import 上；物体识别的 SAM 权重实验室强制离线载入，这台机器缓存里没有，得先预下载。
证据: `agent_docs/runtime/mechanisms/scene-acoustics.md` 与 `editor-tools/mechanisms/acoustic-workbench.md` 已按新定案改写；数据迁移见 `public/assets/data/acoustic_spaces.json`（v2）；实验室修复 `tools/character_lighting_lab/pipeline.py` 两处绝对 import；六个回音场景首次烘深度（`audit-walkable` 结果见本会话收尾汇报）。
建议: 设计稿 §三「两个入口」段落标记已被 2026-09-08 定案取代（本会话已在稿末追加一节）；`character_lighting_lab` 卡（若有）补一句「pipeline.py 是被当脚本起的，模块内不许相对 import」+「SAM 权重要在缓存里」。
