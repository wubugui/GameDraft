---
target: held-prop-lights
date: 2026-09-15
session: 风吹灭 blowout / 玩家操作 playerControl / lockPropState 编辑器侧登记
---

现象: held-prop-lights 卡没写 `blowout`（火势、越线动作 onEmberActions / onOutActions、状态三态 null）、`playerControl`（T / V）与 `lockPropState {lock: lit|unlit|none}`；挂件预设里"会执行的动作列表"从 1 处变 3 处，原先手写 `states[*].onEnterActions` 的扫描面（动作总表 / 保存门 [tag:] / all_flags）已改读 `prop_preview.iter_prop_preset_action_lists`，但 `narrative_state_editor._visit_narrative_assets` 仍整个漏 prop_presets（上一条 inbox 已记）。
证据: tools/editor/tests/test_prop_blowout_and_lock.py（扫描面 / 校验器 / 页面往返）、tools/vfx_workbench/tests/test_blowout_effect_refs.py；validator `_prop_blowout_issues` / `_prop_player_control_issues` / `_lock_prop_state_issues`。
建议: held-prop-lights 补「风吹灭 / 玩家操作 / 锁」一节与「越线动作顶层 playPropVfx 同样注入这件挂件」；action-host 类手写清单一律改读 iter_prop_preset_action_lists。
