---
id: entity-refactor-engine
title: 实体迁移/改名/删除走重构引擎(勿手搓引用网)
domain: content
type: mechanism
summary: 场景实体(npc/hotspot/zone/出生点)的迁移/改名/删除不要手改 JSON 引用网——调 entity_refactor 引擎,引用机械改写+报告+可撤销;裸 id 运行时按当前场景解析、断了静默跳过
status: active
authority:
  - tools/editor/shared/entity_refactor.py#ENTITY_REF_PARAMS
  - tools/editor/shared/entity_refactor_dialog.py
  - tools/editor/editors/scene_editor.py
triggers:
  paths: ["public/assets/scenes/**", "tools/editor/shared/entity_refactor.py"]
  topics: [实体迁移, 迁移地图, 实体改名, 删实体, 出生点, 重构引擎, ENTITY_REF_PARAMS, 可达场景]
  tasks: [把实体搬到别的场景, 改实体id, 删除实体, 改出生点, 调整场景结构]
verified_by:
  - tools/editor/tests/test_entity_refactor.py
last_governed: 2026-07-13
---

## 是什么(一句话)

场景实体(npc / hotspot / zone / spawnPoints 键)被全项目引用(动作参数 / 对话图 /
叙事绑定 / transition / `[tag:npc:]` 文本);迁移、改名、删除属于**重构操作**,必须走
`tools/editor/shared/entity_refactor.py` 引擎,不要手改 JSON 后自己追引用。

## 为什么是硬约束

裸 id 引用(`target`/`npcId` 等)运行时**只在当前场景解析,找不到静默跳过**——手搓迁移
后演出无声丢失,且无场景上下文的兜底校验按全局 id 集放行,`validate-data` 可能全绿。
引擎把能机械改写的全改(场景限定引用 / spawn 与 zone 的入站引用是 100% 机械),改不动
的出分类报告,全程可撤销(`undo_last`)。

## 怎么用

- **人(策划)**:场景编辑器选中实体 → 工具栏「重构」菜单(迁移到场景/重命名 id/安全
  删除/撤销),预览引用报告后确认;几何(坐标/polygon)迁移后需手工重摆。
- **agent(无头)**:`ProjectModel().load_project(root)` → `scan_entity_usages` 看影响面
  → `move_entity` / `rename_entity` / `delete_entity` → `model.save_all()`;引擎零磁盘
  写,落盘只经 save_all。批量结构调整用这条路,别逐文件手改。
- 单点小改(改句台词/挪个坐标)不算重构,直接改 JSON 照旧。

## 硬契约与已知坑

- 改名按歧义分级:id 全局唯一才全量改写;多场景重名只改写可证明指向本实体的引用,
  其余留报告——**宁可少改不错改**,报告里的"需人工"项必须处置。
- 删除**不级联**:引用悬垂交 `validate-data` 报;`[tag:npc:]` 引用着全项目最后一个
  同 id 实例时删除被硬拒(否则整工程保存门 raise)。
- 从叙事图/过场触发的对话图(可达集不封闭)裸引用检测有原理性留白,收尾 warning
  必须逐条处置,不能"没 error 就当对了"。
- 实体改名会使老存档 sceneMemory 键失联(scenes 无 migrations 机制,2026-07-13 拍板
  暂不管)——上线内容改名前留意。
- 新增含实体/场景/出生点引用参数的 action,必须登记 `ENTITY_REF_PARAMS`
  (见 [加 Action 四件套](../../runtime/mechanisms/action-registration-quadruple.md))。

## 怎么验证

改完跑 `./dev.sh validate-data`(新增三类检查:对话图裸引用可达场景 / targetSpawnPoint /
动作树 targetScene);引擎行为契约由 `test_entity_refactor.py` 锁定。
