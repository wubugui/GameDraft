---
target: narrative-signal-spine
date: 2026-08-08
session: 任务系统当前任务槽 / 目标 / 引导 / 醒目提示
---

现象: 脊椎卡把第 5 层写成「quest 纯镜像」，但镜像层此轮长出了**玩家意图态**（全局唯一的「当前任务槽」focusedQuestId，进存档、驱动 HUD 与引导）；它不是叙事状态的投影，卡里没有它的位置，也没说清它与活计激活槽（activatedArchetype）该怎么处。
证据: `src/systems/QuestManager.ts`（focusedQuestId / requestFocusQuest / pickAutoFocusCandidate）、`docs/玩法功能需求清单.md` D6、`src/systems/QuestManager.test.ts` 的「把主线设为当前任务时不动活计激活槽」一例——反向清槽会走 `NarrativeStateManager.suspendOrDiscardActivated`，把非 resumable 的在途活计**直接作废 + aborted++**，所以桥接只能单向。
建议: 脊椎卡第 5 层补一句「镜像 + 一个玩家意图槽」，并把「聚焦活计 → 激活活计图；聚焦一次性任务 → 不动活计槽」这条单向桥接写进硬契约（它是一条会静默销毁玩家进度的反向坑）。
