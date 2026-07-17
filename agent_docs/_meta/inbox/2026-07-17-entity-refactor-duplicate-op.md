---
target: entity-refactor-engine
date: 2026-07-17
session: 场景编辑器补复制 entity 能力
---

现象: 卡内 op 清单为「迁移/改名/安全删除」，引擎已新增第四个 op `duplicate_entity`（同场景复制：deepcopy+探测取号+几何平移+剥离过场绑定+journal 撤销），场景编辑器「重构」菜单挂了「复制实体（本场景）」+Ctrl+D。
证据: tools/editor/shared/entity_refactor.py#duplicate_entity、tools/editor/tests/test_entity_refactor.py（duplicate 契约组）、tools/editor/tests/test_scene_entity_duplicate_flow.py（最外层入口流程探针）；同轮 validator 补了「场景内实体 id 重复」error 检查（此前零检查）。
建议: 卡的 op 清单加 duplicate 一行；「怎么用」补 agent 无头路径 `duplicate_entity(model, sid, kind, eid)`；跨场景复制未做（需出站引用扫描，二期）。
