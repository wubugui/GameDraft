---
target: action-registration-registry-surfaces
date: 2026-09-16
session: 燃烧 A3.8 改「模板 + 宿主 burnable 块」后重接主编辑器 / 校验器 / 登记面
---

现象: 同日早些的 `2026-09-16-burn-editor-surfaces.md` 记的布置库接线已全部作废（burn_placements.json 已删）——燃烧动作 target 的 ref kind 从只认热点的 `hotspot` 改成 `burn_target`（_BARE_KIND_SCOPE=npc+hotspot，json_lang 宇宙 emote_subjects，_HARD_BARE_REF_KINDS 同步），三个动作加可选 `socket`（写了 = target 是拿东西的人）；实发信号第 5 源从「布置库 signals」改成「宿主身上 burnable.signals」（热点 / NPC / 挂件预设 / 轨迹 spawn 规格），并进 `_collect_emitted_signal_ids` 与 xref `_walk` 的同一趟深扫（`narrative_catalog.burnable_host_signal_fields`，xref 行 readonly）。
证据: tools/editor/shared/entity_refactor.py ENTITY_REF_PARAMS 燃烧三行；tools/editor/shared/narrative_catalog.py burnable_host_signal_fields；tools/narrative_xref/scan.py BURN_HOST_MARK；tools/editor/project_model.py burn_target_ids / burnable_spawn_specs；tools/editor/tests/test_burn_editor_surfaces.py。
建议: 两张卡（action-registration-registry-surfaces 的 ref kind、emitted-signal-catalog 的实发源）按此改；剪贴板一节 `_PASTE_CHECKED_BARE` 仍列着已无人使用的 `hotspot`、没列 `burn_target`（该节归别的会话），`signal_refactor` 改名 / 删信号也还不改写 burnable.signals——两处待补。
