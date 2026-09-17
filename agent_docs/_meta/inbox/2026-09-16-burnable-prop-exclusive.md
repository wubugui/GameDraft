---
target: held-prop-lights
date: 2026-09-16
session: 可燃物模板化 · 宿主编辑面
---

现象: 挂件预设开了 burnable 之后，灯 / 粒子挂载 / 火苗 / 起火点 / 玩家操作 / 吹熄 / 点火能力 / 燃料 / 效果块 / 等级 / 状态表与可燃互斥，贴图与支点被模板接管；卡里没有这一条，照卡给可燃挂件配灯会被校验器拦。
证据: tools/editor/shared/prop_preview.py BURNABLE_EXCLUSIVE_KEYS / burnable_prop_placement；tools/editor/editors/prop_preset_editor.py _sync_burnable_exclusive；tools/editor/tests/test_prop_burnable_block.py
建议: 挂件预设那节补「可燃挂件（A3.8）」一句并指向 burn-system。
