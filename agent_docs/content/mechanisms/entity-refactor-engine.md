---
id: entity-refactor-engine
title: 实体迁移/改名/删除走重构引擎(勿手搓引用网)
domain: content
type: mechanism
summary: 场景实体(npc/hotspot/zone/出生点)的迁移/改名/删除/复制不要手改 JSON 引用网——调 entity_refactor 引擎,引用机械改写+报告+可撤销;裸 id 运行时按当前场景解析、断了静默跳过
status: active
authority:
  - tools/editor/shared/entity_refactor.py#ENTITY_REF_PARAMS
  - tools/editor/shared/entity_refactor_dialog.py
  - tools/editor/editors/scene_editor.py
triggers:
  paths: ["public/assets/scenes/**", "tools/editor/shared/entity_refactor.py"]
  topics: [实体迁移, 迁移地图, 实体改名, 删实体, 复制实体, 出生点, 重构引擎, ENTITY_REF_PARAMS, 可达场景]
  tasks: [把实体搬到别的场景, 改实体id, 删除实体, 复制实体, 改出生点, 调整场景结构]
verified_by:
  - tools/editor/tests/test_entity_refactor.py
  - tools/editor/tests/test_scene_entity_duplicate_flow.py
last_governed: 2026-08-05
---

## 是什么(一句话)

场景实体(npc / hotspot / zone / spawnPoints 键)被全项目引用(动作参数 / 对话图 /
叙事绑定 / transition / `[tag:npc:]` 文本);**迁移、改名、删除、同场景复制**都属重构操作,
必须走 `tools/editor/shared/entity_refactor.py` 引擎,不要手改 JSON 后自己追引用。

## 为什么是硬约束

裸 id 引用(`target`/`npcId` 等)运行时**只在当前场景解析,找不到静默跳过**——手搓迁移
后演出无声丢失,且无场景上下文的兜底校验按全局 id 集放行,`validate-data` 可能全绿。
引擎把能机械改写的全改,改不动的出分类报告,全程可撤销(`undo_last`)。

## 怎么用

- **人(策划)**:场景编辑器选中实体 → 工具栏「重构」菜单(迁移/改名/安全删除/复制/撤销),
  预览引用报告后确认;几何(坐标/polygon)迁移后需手工重摆。
- **agent(无头)**:载入 `ProjectModel` → 先 `scan_entity_usages` 看影响面 → 调对应 op →
  `model.save_all()`;**引擎零磁盘写,落盘只经 save_all**。批量结构调整走这条路,别逐文件手改。
- 单点小改(改句台词/挪个坐标)不算重构,直接改 JSON 照旧。

## 换种类:纯展示热点 → NPC

`convert_hotspot_to_npc`(编辑器「重构 → 转为 NPC」)。**id 不变,所以引用网零改写**——
`emote_subject` 本就认 npc、`actor` 只是从"命不中"变成"命中"、场景限定引用寻址不变。
只拦两类必然失效的:

- 带 NPC 接不住的交互载荷(正文浮层 / inline actions / pickup / transition / encounter…)→ **拒绝**;
  只有 `inspect` 且 data 只有 `graphId` 的可以转(平移成 `dialogueGraphId`,NPC 的交互出口就是图对话)。
- `setHotspotDisplayImage` / `tempSetHotspotDisplayFacing` / `persistHotspotEnabled` 指向它 → 需 force 并自行清理。

两处**默认值不同、不显式写死就会静默变行为**:`perspectiveScaleEnabled`(热点缺省 false、
NPC 缺省 true,引擎自动钉成 false)与摆位口径(热点把整幅矩形拉伸、NPC 紧裁到内容;
按 `atlas.meta.json` 的 `sourceCanvas`/`sourceContentBox` 补偿 x/y 与 scale,缺这两个数只能
按矩形估并告警。实测码头人群源图底部 17% 留白 → 不补偿会下沉 68 个世界单位)。

## 硬契约与已知坑

- 改名按歧义分级:id 全局唯一才全量改写;多场景重名只改写可证明指向本实体的引用,
  其余留报告——**宁可少改不错改**,报告里的"需人工"项必须处置。
- 删除**不级联**:引用悬垂交 `validate-data` 报;`[tag:npc:]` 引用着全项目最后一个
  同 id 实例时删除被硬拒(否则整工程保存门 raise)。
- **复制只支持同场景**:副本自动取号并**剥离过场绑定**(present 步按 id 只驱动原实体,
  副本挂着绑定既无人驱动、`cutsceneOnly` 副本还会被常隐藏);跨场景复制未实现(需出站
  引用扫描),别手搓代替。
- 从叙事图/过场触发的对话图(可达集不封闭)裸引用检测有原理性留白,收尾 warning
  必须逐条处置,不能"没 error 就当对了"。
- 实体改名会使老存档 sceneMemory 键失联(scenes 无 migrations 机制,拍板暂不管)——
  上线内容改名前留意。
- 新增含实体/场景/出生点引用参数的 action,必须登记 `ENTITY_REF_PARAMS`
  (见 [加 Action 的登记面](../../runtime/mechanisms/action-registration-registry-surfaces.md))。
- **`ENTITY_REF_PARAMS` 是 actor 类引用的唯一真相源,校验器读它、不得另抄**:手抄的第二份
  清单一旦漂开,那些 action 的 target 悬垂时**一声不吭**——运行时那步静默跳过、校验全绿
  (真实数据里已抓到过存量一例)。要拦的是"登记了却没人真校验",所以护栏必须是**语义级**
  的(喂一个悬垂 id 进去必须报),不是"两份清单字面相等"。软引用(命中不了就当显示名)
  是**刻意豁免**的一档,报不报由调用点定。
- **speaker 引用通道漏扫过**:显式带 `npcId` 的说话人 kind 是 `sceneNpc` 而非裸 `npc`,
  引擎早期只认 `npc`、整条通道漏扫漏改且报 0 处引用;改动图节点 speaker 形状时同步
  `_SPEAKER_NPCID_KINDS` 与其 parity 探针。
- **`data.npcId` 只对 `type == "npc"` 的热点算引用**:运行时先 `switch (def.type)`
  才读它(`src/utils/hotspotInteraction.ts#hotspotOffersPlayerInteraction`),别的 type 上的
  同名键没有任何消费者(场景编辑器 Apply 也会按 `_managed_data_keys` 清掉)。扫描侧与
  改写侧曾各写一份判定(扫描不看 type、改写看),于是重构预览把这种残渣算进「改名会跟随
  改写」的承诺里,而 `rename_entity` 实际不动它——**改完静默指空**,要等 `validate-data`
  才发现。现两侧共用 `_npc_data_ref_hit` / `_visit_npc_data_refs`(同一次遍历、同一个
  判定),parity 由 `test_scan_and_rename_agree_on_npc_data_refs` 锁死。

## 怎么验证

改完跑 `./dev.sh validate-data`(含对话图裸引用可达场景 / targetSpawnPoint / 动作树
targetScene / 场景内实体 id 重复);引擎行为契约由 `test_entity_refactor.py` 锁定。
