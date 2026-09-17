---
target: action-registration-registry-surfaces
date: 2026-09-16
session: 燃烧系统 A3.8 接进主编辑器 / 校验器 / 登记面
---

现象: 卡的 ref kind 列表与 emitted-signal-catalog 的「实发四源」都过期了——燃烧动作 target 新增裸热点 kind `hotspot`（_BARE_KIND_SCOPE 只认热点，json_lang REF_KIND_UNIVERSE→hotspots、_KNOWN_REF_KINDS、validator 可达性、test_action_manifest_parity._HARD_BARE_REF_KINDS 同步）；叙事信号实发多了第 5 源「燃烧布置库 signals」（不是动作树形状，narrative_catalog.burn_placement_signal_ids + narrative_xref 燃烧布置发射行，readonly）。
证据: tools/editor/shared/entity_refactor.py ENTITY_REF_PARAMS 燃烧三行；tools/editor/shared/narrative_catalog.py emitted_signal_ids 第 5 步；tools/narrative_xref/scan.py _scan_burn_placements；tools/editor/tests/test_burn_editor_surfaces.py。
建议: 两张卡各补一行；另外 burn_placements.json 的「场景→热点 id」键也引用热点，但主编辑器改名不改它（唯一写者燃烧工作台），改名后由校验器报 error、热点检视器提醒，重构卡「谁引用它」清单里该记上这一条。
