---
id: archive-unlock-single-action
title: 人物档案解锁只走一个动作
domain: runtime
type: decision
summary: 人物档案解锁唯一通道=addArchiveEntry;名字匹配、条件自动解锁、unlockConditions 字段全部删除
status: active
triggers:
  topics: [档案, 人物解锁, addArchiveEntry]
last_governed: 2026-07-11
---

## 背景(一段)

2026-06-30 档案系统审查发现人物解锁有三条并行通道(对话开始时按 NPC 名字匹配、声明式条件自动解锁、动作),行为交叉难排查。用户拍板:"就一个动作,其它全不要"。

## 决定(一句)

人物档案解锁唯一入口 = `addArchiveEntry` 动作(幂等,可直接挂首次对话节点);lore/documents/book-entry 保留声明式条件不受影响(机制见 [archive-unlock-semantics](../mechanisms/archive-unlock-semantics.md))。

## 被否方案(防翻案)

- **名字匹配自动解锁**(tryUnlockCharacterByNpc + dialogue:start 监听):已连代码删除。
- **人物条件自动解锁 / `CharacterEntry.unlockConditions` 字段**:type/编辑器/validator/数据全清,编辑器还会主动 pop 该历史死字段。
- 旧茶馆/test 遗留人物(waiter_xiaoer/peddler/wang_grandpa)不接也不删,用户拍板不用管。
