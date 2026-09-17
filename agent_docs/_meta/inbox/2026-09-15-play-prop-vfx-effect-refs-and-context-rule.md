---
target: vfx-workbench
date: 2026-09-15
session: playPropVfx 编辑器侧登记
---

现象: vfx-workbench 卡说效果改名 / 删除只查「挂件预设 particles + 数据里的 playVfx」，现在 playPropVfx.effect（常住 prop_presets 状态 onEnterActions）也算外部引用；held-prop-lights / action-registration 卡都没写 playPropVfx 的「只有 onEnterActions 顶层可省 target/socket」位置规则。
证据: tools/vfx_workbench/placements.py `_EFFECT_ACTIONS`；tools/editor/validator.py `_play_prop_vfx_issues` + `_walk_action_defs(prop_state_self=)`；tools/editor/tests/test_play_prop_vfx_action.py。
建议: vfx-workbench「删除 / 改名效果查外部引用」补 playPropVfx；held-prop-lights 动作一节补 playPropVfx 与位置规则；另 ActionRow 末尾「未登记参数原值透传」会把控件有意不写的 schema 参数塞回去（attachToSocket 清空 images 存不下去，实测），playPropVfx.point 已用 withheld 集合绕开，其余控件未修。
