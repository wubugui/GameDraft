---
id: system-sfx-event-table
title: 系统音效事件表(横切,挂在音频管理器上)
domain: runtime
type: mechanism
summary: 系统音效统一挂音频管理器的事件映射表、不在各功能自己的 manager 里;判"某功能有没有声音"必须先读那张表,靠 grep 功能模块必漏、必做出双响
status: active
authority:
  - src/systems/AudioManager.ts#installSystemSfxListeners
triggers:
  paths: ["src/systems/AudioManager.ts", "public/assets/data/audio_config.json"]
  topics: [音效, sfx, systemSfx, 系统音, 双响]
  tasks: [给功能加音效, 查某功能有没有音效, 改音频配置]
last_governed: 2026-09-03
---

## 是什么(一句话)

系统音效是**横切能力**:它统一订阅事件总线,由音频管理器里的一张事件→音效映射表发声,
**不住在触发它的那个功能系统里**。

## 权威源(读代码从哪进)

`AudioManager` 的 `installSystemSfxListeners` —— 事件名到 `systemSfx` 条目的映射表就是清单本体,
音效 id 与音量在音频配置数据里。**清单以这段代码为准,不要抄任何文档里的表。**

## 硬契约(违反即 bug)

- **判断"某功能有没有音效"必须先读这张表**。功能自己的 manager 里搜不到播放调用,
  **不等于**没声音——全局默认音很可能一直在响。跳过这一步就会再造一套,结果是双响。
- **逐条音效必须与全局音二选一**:数据侧给某条内容配了专属音时,派发的事件负载要带上
  "本条自带音"的标记让全局表**跳过**;两边都响是这条契约唯一的失败模式,而它只在真机听得出来。
- 新增一类系统音 = 在这张表上加一行 + 在音频配置里加对应条目,**不要**在功能系统里直接播——
  分散播放会让上面两条都失守。
- **表里的值可以带本处音量**(`{ id, volume }`):同一条素材当确认音要清脆、当悬停音就得压到
  三分之一,靠这一条而不是在音频目录里复制一份改 volume。口径见[逐处音量](per-site-audio-volume.md)。
  ⚠ 于是值**不再一定是字符串**:`a || b || c` 串起来再 `.trim()` 会当场崩(对象是真值)。

## 已知坑

- 表里有若干条带**条件跳过**(读档补发的事件、嵌套/链式接续的中间态、节流)。
  加新监听前先看邻居怎么写的:同一个事件在"真发生"与"恢复/中途"两种语境下都会来。
- 这类横切能力**靠 grep 功能模块必漏**。要确认到底响不响,真机上 hook 播放入口跑一遍最快
  (走[命令通道](../recipes/runtime-command-channel.md))。

## 怎么验证

真机触发该功能,听/hook 播放入口:**必须恰好响一次**。配了逐条音时另验全局音确实被跳过。
