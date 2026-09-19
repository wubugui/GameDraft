---
target: action-registration-registry-surfaces
date: 2026-09-19
session: leifu-skill
---

现象: 卡只讲「新动作要在哪几张表登记」,没提执行期 `ActionExecutor` 会把每条动作的 Exploring 切成 ActionSequence——于是"背景演出"用普通动作批写出来,玩家被 `waitMs` 钉在原地约 9 秒(制作人报"放了技能完全不能动")。
证据: `src/core/ActionExecutor.ts#runWithExploreActionLock`;修复与新机制见新卡 `runtime/mechanisms/detached-performance-session.md`。
建议: 在本卡「已知坑」加一行指向脱手演出会话那张卡。
