---
target: missing
date: 2026-09-30
---

现象: RHI/构建机制卡尚未说明每帧全资源抓取、按内容版本复用 Draw 输入读回和本机项目外输出目录设置。
证据: src/dev/webgpuCaptureClient.ts 与 tools/webgpu_capture/server.mjs 已按渲染→读回→落盘→下一帧执行；真实 1 帧与 8 帧 job 99555268ce81407a9934b194e8067db1、6281352fb0be17d347d3662c39973e3f 在 F:\GameDraftCaptures\webgpu 完成，外部审计存 F:\build\GameDraft-CaptureAll-QA-20260930。
建议: 补充抓帧机制卡，说明全部 live RHI mip/layer/aspect 和 whole Buffer、每 Pass-end RT、每 Draw 绑定证据、内容版本与写入区间检查、逐帧磁盘背压、F2/agent 目录设置及 GPU 时间戳口径。
