---
target: zone-lifecycle-contracts
date: 2026-08-06
session: zone 按 E 交互
---

现象: 卡里 zone 只有「进出即触发」这一种触发载体,现已新增 `ZoneDef.onInteract` + `interactLabel`——进区不发生任何事,HUD 底部出提示条、按 E 才跑动作批(优先级:目标级 hotspot/NPC 的 E → 区域级;位面 `canInteractHotspots=false` 时一并禁)。
证据: `src/systems/ZoneSystem.ts` 的 `getInteractableZone`/`dispatchZoneInteract`(仍走 `enqueueZoneActions` + `zoneOrigin` 线程化)、`src/systems/InteractionSystem.ts` 的 `setZoneInteractBinding`/`zone:interactAvailable` 事件、`src/ui/HUD.ts` 的 `setZoneInteractHint`;测试 `src/systems/ZoneInteract.test.ts`(7)+ `tools/editor/tests/test_zone_interact_section.py`(5);真机验:test_room_a 临时区走进不触发、按 E 出通知(已还原场景文件)。
建议: zone 卡的「触发载体」一节补 onInteract 这一路;另记两条现实——① `ActionEditor.to_list()` 会把 param schema 的可选参数补成空串(`showNotification.type`),onEnter/onStay/onExit/onInteract 一视同仁,别当成新区块的往返 bug;② `tools/graph_editor/panels/zone_panel.py` 仍只认 onEnter/onStay/onExit(onPlayerAct/smell/onInteract 靠透传),切 depth_floor 时不清这三类,与主编辑器不同口径。
