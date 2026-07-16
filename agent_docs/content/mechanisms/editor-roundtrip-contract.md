---
id: editor-roundtrip-contract
title: 编辑器可往返硬契约
domain: content
type: mechanism
summary: agent 写的 JSON 必须让人类仍能用编辑器打开并原样存回——格式/文件范围/重建区/deprecated/引用有效五组契约,违反即丢数据或整工程存不了
status: active
authority:
  - docs/editor-authoring-surface.md
  - tools/editor/validator.py
triggers:
  paths: ["public/assets/data/**", "public/assets/scenes/*.json", "public/assets/dialogues/graphs/*.json"]
  topics: [往返, roundtrip, 编辑器契约, 重建区, deprecated]
  tasks: [做内容, 改JSON]
last_governed: 2026-07-11
---

## 是什么(一句话)

AI 直接改 JSON、人类只经编辑器维护——所以每处 JSON 都必须能被编辑器打开、编辑、原样存回;违反的后果是人类一保存就静默丢数据或炸全文 diff。

## 权威源(读哪进)

字段级"哪些字段能安全写"的完整地图:`docs/editor-authoring-surface.md`(按面板逐项列可编辑面/危险区)。保存侧闸门实现:`tools/editor/validator.py` 与各编辑器 save 路径。

## 硬契约

- **格式**:`ensure_ascii=False` + 2 空格缩进 + 文件末尾单个换行 + UTF-8;中文不转义成
  `\uXXXX`;**不排序键**,不挪未触碰键的位置。
- **只改编辑器管理的文件**:`public/assets/data/**`、`public/assets/scenes/*.json`、
  `public/assets/dialogues/graphs/*.json`、`narrative_graphs.json`。**不碰**:`anim.json`
  (编辑器只读)、`.ink`、`public/resources/runtime/**` 媒体。
- **重建区**(编辑器 Apply 整体重建的子结构,塞自定义键会被抹)——2026-07-13 收缩为**四项**:
  被编辑过的对话节点、已知 cutscene present 步、`item.dynamicDescriptions`(条目无稳定身份不可安全合并)、`scenario.phase`。
  **已改为"未知键透传"、不再是重建区**:`hotspot.data`(含著名的 inspect `data.text` 丢失)、`spawnPoint`——见 `tools/editor/shared/rebuild_merge.py`(managed=面板编辑键并集;清空的字段不复活、换类型旧键仍清理);`npc.patrol` 与音频条目**本就保留**未知键(旧契约"只留 src/只 route+speed"表述过时)。
  注意:CLAUDE.md §2 与 `docs/editor-authoring-surface.md` 仍列旧的八项重建区清单尚未同步(前者为冻结路由文件)——以本条为准。
- **deprecated 字段别写**(编辑器主动删):`quest.nextQuestId`、rule 旧 `verified/description/source`、
  `zone.x/y/width/height/ruleSlots`、`npc.dialogueFile/dialogueKnot`、cutscene 旧 `commands`。
- **引用必须有效(最硬闸门)**:`[tag:…]` 目标与跨文件 ID(targetScene/encounterId/
  dialogueGraphId/nextQuests/cutscene id…)必须存在,否则编辑器保存直接 `raise`、整工程存不了;
  strings 之间不得有引用环。
- **ID 一致性**:minigame 实例文件 `id` == index.json 里的 `id`;场景文件 `id` == 文件名。

## 已知坑

- **盲区即升级信号**:运行时支持但 GUI 改不到的字段(`changeScene.cameraX/cameraY`、
  `flag_registry.migrations/runtime`、扎纸小游戏多数高级字段、非档案富文本 `[img:…]`)——
  落到这里按 L2 补编辑器支持或上报,不闷头写。
- `narrative_graphs` 要守住当前 `schemaVersion`、`transition.trigger` 只用合法枚举,否则被编辑器自动迁移改写。

## 怎么验证

改完跑双校验门(见 [content-validation-gate](../recipes/content-validation-gate.md));最终裁判是"人类开编辑器打开改一下存回,diff 只含预期变更"。
