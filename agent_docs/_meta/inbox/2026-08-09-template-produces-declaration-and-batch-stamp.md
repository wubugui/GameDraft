---
target: narrative-template-system
date: 2026-08-09
session: 私有信号 PyQt 侧补齐（任务 B 批量盖章）
---

现象: 卡里写「盖章三产物全有全无」，现在模板可用 `produces` **声明自己盖哪几样**（缺省仍按骨架推断，老模板零改动），参数可用 `from: entity.id|entity.kind|entity.label|scene.id` 绑定被盖实体；另有场景编辑器右键「应用状态机模板…」的**批量**盖章入口（`tools/editor/shared/narrative_template_batch.py`），全有全无与零磁盘写沿用同一条契约，产物记 `composition.stampedFrom {templateId, templateVersion}`。
证据: `tools/editor/shared/narrative_templates.py`（PRODUCT_KINDS / PARAM_SOURCES / template_produces / attach_stamp_provenance）、`tools/editor/editors/scene_editor.py#_apply_state_machine_template_to_selection`、护栏 `tools/editor/tests/test_narrative_template_batch.py`（含 17 条失效探针全部反证）。
建议: 卡的硬契约 4 补一句「产物族可声明」；已知缺口另记——批量盖章写 `model.narrative_graphs` 时，叙事网页若开着草稿会在下次保存覆盖掉这批**作曲**（信号有 merge_host_only_author_signals 兜底、作曲没有），现由场景页开工前的脏草稿闸拦住，不是真同步。
