---
target: runtime-norms
date: 2026-09-14
session: F2 日志被 [emote/target] 每帧刷屏
---

现象: F2 调试日志是 50 行环形缓冲（`DebugPanelUI` 的 `LOG_MAX_LINES`），每帧路径上任何无条件的 `debugPanelUI.log` 都会在 50 帧内把别的诊断冲光；`Game.resolveEmoteTarget` 的命中行被头顶闲聊（`BubbleChatterSystem.collectCandidates`，选人在判条件之前，条件恒假的组每帧都走到）和气泡档对白跟人（`DialogueUI.followBubbleAnchor`）每帧调用，跑马梁闲逛时 `[sway]` 这类行根本读不到。库里没有「每帧路径不许无条件记日志」这一条。
证据: 堆栈实测 30 tick = 30 行、全部来自 Game.tick→BubbleChatterSystem.update→collectCandidates→resolveAnchor；修后 600 tick 0 行（每帧调用方改走 `Game.pollEmoteTarget`：按「调用方×目标 id」的结果变了才记，未命中照样带热点枚举记一次；一次性动作路径每次照记）。
建议: runtime-norms 或调试面板相关卡补一条：往 F2 日志写之前先判这个调用点在不在每帧路径上；每帧路径只记状态变化，不记稳态。
