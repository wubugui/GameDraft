---
target: editor-tools-norms
date: 2026-09-15
session: 燃烧物契约 · prop 预设 states[*].onEnterActions 接入全部动作扫描面
---

现象: 新增一个"带动作列表的位置"要手改 9 张清单（signal_refactor.EMIT_SOURCE_BUCKETS / narrative_catalog._EMIT_SOURCE_ATTRS / narrative_xref.ASSET_SPECS / dialogue_graph_refactor._ACTION_SOURCE_BUCKETS / flag_registry_editor._flag_ref_domains / quest_editor._quest_ref_scan_units / ref_validator / action_registry_editor._scan_actions / project_model.all_flags），其中后 5 张无 parity 护栏，且已各自漂开：flag 引用面与任务引用面至今漏 clues_registry，all_flags 此前连 items[].use.actions 都不扫，narrative_state_editor._visit_narrative_assets 漏 items/clues/prop_presets；另 PropPresetEditor._on_select 原本无 commit-on-leave（切条目丢编辑，已修）。
证据: tools/editor/tests/test_held_prop_editor_surfaces.py::PropStateOnEnterActionScanTests（去掉登记 7/10 红）、test_prop_preset_editor.py::test_switching_preset_commits_the_edit_on_leave（去掉提交 2/2 红）。
建议: 把 EMIT_SOURCE_BUCKETS 定为"动作宿主域"唯一登记入口，其余手写清单改读它或配 parity 测试。
