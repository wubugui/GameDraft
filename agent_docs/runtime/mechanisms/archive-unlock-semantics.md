---
id: archive-unlock-semantics
title: 档案系统解锁语义
domain: runtime
type: mechanism
summary: 人物档案解锁唯一入口=addArchiveEntry(幂等);lore/doc/book 走声明式条件;totalPages 只认 pages.length
status: active
authority:
  - src/systems/ArchiveManager.ts
  - src/core/ActionRegistry.ts#addArchiveEntry
triggers:
  paths: ["src/systems/ArchiveManager.ts", "public/assets/data/characters.json", "public/assets/data/books.json"]
  topics: [档案, archive, 人物解锁, lore]
last_governed: 2026-07-11
---

## 是什么(一句话)

档案(Characters/Lore/Documents/Books)的解锁通道:人物走动作、其余走声明式条件。

## 权威源(读代码从哪进)

`src/systems/ArchiveManager.ts`(addEntry/loadDefs/seeding);动作注册在 `ActionRegistry.ts` 的 `addArchiveEntry`。

## 硬契约(违反即 bug)

- **人物档案解锁唯一入口 = `addArchiveEntry` 动作**(bookType=character)。名字匹配、dialogue:start 监听、条件自动解锁、`unlockConditions` 字段已全部删除——别按旧印象找回来(拍板见 [2026-06-30-archive-unlock-single-action](../decisions/2026-06-30-archive-unlock-single-action.md))。
- **addArchiveEntry 幂等**(guard+unlocked 集合入存档),可直接挂"第一次说话"节点。推荐范式:图 entry 前插一个 runActions 节点做解锁再 next 到原 root。
- lore/documents/book-entry 走声明式 `unlockConditions`/`discoverConditions`,留空=开局即解锁。
- `loadDefs()` 初次评估 `seeding=true` 静默播种:startupFlags 命中的条目入解锁集但不喷 toast/音效——改初始化顺序别弄丢这个静默语义。
- `book.totalPages` 运行时只认 `pages.length`(顶层字段无人读);编辑器已做只读派生,别在数据里手填。

## 已知坑

- 运行时人物条目按 id 存 Map、last-wins:数据里 id 重复会让档案"凭空消失"(validator 已加顶层 id 去重 error)。

## 怎么验证

对话图里挂 addArchiveEntry 后经 [runtime-command-channel](../recipes/runtime-command-channel.md) 触发对话,读快照/存档断言解锁集;重复触发确认只解锁一次。
