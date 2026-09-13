---
target: trajectory-workbench
date: 2026-09-12
session: 轨迹音效关键点
---

现象: 工作树里 `npc_验证铜钱` 的 `displayImage` 从 14 wu 改成了 7 wu，但 `coin_drop_demo` 没重烘，钉单 `test_coin_roll_anchor.py::test_lowest_point_never_below_the_contact_line` 红着（atMs=5217 处沉地 1.22 wu）——工作台没有任何东西提示"这条轨迹的尺寸参数与它的预览实体已经对不上了"。
证据: `git show HEAD:public/assets/scenes/雾津街头.json` vs 工作树，worldWidth/Height 14 → 7；`sh scripts/py.sh -m pytest tools/trajectory_workbench/tests/test_coin_roll_anchor.py` 复现（与本次音效关键点改动无关，改动前后同样红）。
建议: 工作台打开资产时把 `source.bake.restHeight / contactOffsetY` 与当前预览实体的尺寸对一次，差得多就在右栏出黄字（"取自预览实体"按钮已经在那儿，只是没人提醒该点）。
