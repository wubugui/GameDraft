---
target: production-mode-workflow
date: 2026-09-13
session: 策划模式·上跑马梁流程
---

现象: production-mode skill 规定进模式必读 `E:\GameDev\FindingDogStory\故事设计\主线故事进度.md`，本机该路径不存在（E:\GameDev 下无 FindingDogStory）。
证据: 实际位置 `H:/FDStory/FindingDogStory/故事设计/主线故事进度.md`；`.cursor/skills/production-mode/SKILL.md` 第 31、152 行仍写 E: 路径。
建议: 路径改由制作人确认后更新 skill；跨机（Win+Mac）差异大，考虑写成「以制作人给的位置为准」或放可配置指针。
