---
target: footstep-and-spatial-audio
date: 2026-09-16
session: 燃烧系统 A3.8 编辑器侧 igniteSlots 勾选
---

现象: 卡只写 contactSlots；sockets.json 现多了与之同口径的 igniteSlots（点火接触帧），同面板「点火 · 接触帧」组勾，save_socket_set 删文件判据已含它，卡里「两样都空才删」已不准；另外委派方以为落脚帧勾选框 stale 时禁用，实际 stale 时照常可勾（重标保存即刷新指纹），点火接触帧照此。
证据: tools/editor/shared/animation_sockets.py（IGNITE_SLOTS_KEY / ignite_slots_of / set_ignite_slot）、tools/editor/shared/socket_panel.py `_sync_contact_field`、tools/editor/tests/test_ignite_slots.py。
建议: 卡里补 igniteSlots 一行（或另起燃烧卡指回这里），把「两样都空」改成「挂点/落脚帧/点火接触帧三样都空」。
