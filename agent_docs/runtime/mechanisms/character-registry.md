---
id: character-registry
title: 角色注册表(characterId 合并)
domain: runtime
type: mechanism
summary: 角色身份(name/animFile/portraitSlug)一处定义,NpcDef.characterId 引用,实例化时合并且 own 字段赢过注册表
status: active
authority:
  - src/data/characterRegistry.ts#applyCharacterDefaults
  - public/assets/data/character_registry.json
triggers:
  paths: ["src/data/characterRegistry.ts", "public/assets/data/character_registry.json", "tools/editor/editors/character_registry_editor.py"]
  topics: [角色注册表, characterId, NPC 身份, 换装]
last_governed: 2026-07-11
---

## 是什么(一句话)

同一角色跨多场景不再重复配置:身份三元组(显示名/动画包/立绘集)集中在 `character_registry.json`,场景 `NpcDef.characterId` 引用,`SceneManager.instantiateNpc` 时经 `applyCharacterDefaults` 合并。

## 权威源(读代码从哪进)

`src/data/characterRegistry.ts`(applyCharacterDefaults / portraitSlugFromAnimFile);Boot 链:Game.loadCharacterRegistry → SceneManager.setCharacterRegistry。

## 硬契约(违反即 bug)

- **own-first 合并**:NpcDef 自身字段赢过注册表——这同时是"按摆放覆盖装扮"的运行时基础(编辑器只在值异于继承时写 own 键)。
- `portraitSlug` 留空且动画包目录名==立绘目录名时,经 `portraitSlugFromAnimFile` 自动推导——不是所有 NPC 都需要显式配。
- back-compat:空注册表=no-op,characterId 可选;别把它做成必填。
- 玩家同属"角色配置"体系(game_config.playerAvatar 带 portraitSlug),见 [dialogue-portrait-runtime](dialogue-portrait-runtime.md)。

## 已知坑

- **编辑器等注册表外的消费方享受不到运行时合并**:凡直接 `npc.get("animFile")` 拿身份的地方,characterId NPC 会拿到空(踩过:画布 sprite 消失)。编辑器侧一律走 `ProjectModel.character_field(npc,key)` 解引用——名字标签、动画下拉、画布 sprite、世界尺寸全算。
- 共 owner 图的 speaker 必须 `kind:sceneNpc`(见立绘卡的坑)。

## 怎么验证

validate-data 查 characterId 悬空引用(error);真机换装/跨场景同角色显示名一致;编辑器往返有探针用例(干净继承不 bake / 设覆盖 / 清覆盖)。
