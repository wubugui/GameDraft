---
target: missing
date: 2026-08-10
session: 文档揭示配音效
---

现象: 查「文档揭示有没有音效」时 grep DocumentRevealManager 一无所获，差点得出「没有音效」的结论并
新造一套——真机一跑才发现全局默认揭示音一直在响：系统音效挂在 AudioManager.installSystemSfxListeners
的事件表里（`document:revealed` → systemSfx.documentReveal），不在功能自身的 manager 里。
凡「某功能有没有声音」的判断，必须先读那张事件表，否则必然做出双响。
证据: src/systems/AudioManager.ts installSystemSfxListeners（40 条 systemSfx 事件映射，
audio_config.systemSfx.documentReveal → sfx id `document_reveal`）；本次给
document_reveals.json 加逐条 revealSfx 后，`document:revealed` payload 补 `customSfx` 让
AudioManager 跳过全局音（逐条覆盖全局），护栏
src/systems/AudioManagerDocumentRevealSfx.test.ts + src/systems/DocumentRevealManager.test.ts。
建议: 库里缺一张「系统音效事件表」的机制卡（挂载点在 AudioManager 而非各功能系统；新增逐条音效
必须与全局音选一条，别叠着响）；同时值得记一条方法教训——音效这类横切能力靠 grep 功能模块必漏，
真机 hook `audioManager.playSfx` 一跑即真相。
