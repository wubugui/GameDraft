---
target: light-authoring-gizmos
date: 2026-09-12
session: 场景灯 follow 作者面
---

现象: 卡里的逐参数结论表说「点光**只有位置需要手柄**」，而 2026-09-12 的 `LightDef.follow` 让这句在跟随灯上反了 —— 配了 `follow` 的灯 `pos` **完全不参与光照**（`SceneLightingSystem.effectiveLights` 见 `follow` 就跳过原件，`HeldPropSystem` 每帧解一盏运行时灯），位置手柄/画布定位对它是纯骗人：作者点半天，进游戏灯在别处，而画面上"摆错了"与"这盏灯坏了"照卡里那条判据完全无法区分。卡里也没有 `follow` 这一行。
证据: `src/data/types.ts` 的 `LightFollowDef` 与 `LightDef.follow`；`src/core/SceneLightingSystem.ts:603` 的 `if (l.follow) continue;`；`src/systems/heldProp/HeldPropSystem.ts#resolveFollowLight`。编辑器侧已按此停用画布定位并在按钮上写「跟着 X 走」（`scene_editor._sync_sl_place_affordance` + `place_selected_light_at` 里侧同门），护栏 `tools/editor/editors/tests/test_scene_lights_follow.py::TestPlaceAffordance`。
建议: 卡里加一行 `follow`：**它不是手柄参数，而是把 `pos` 整个作废的开关** —— 门控判据是"`follow` 块在不在"而不是"`target` 填没填"，摆灯手柄一律要按它停用并说出跟着谁走；顺带把「点光只有位置需要手柄」那句加个例外注。
