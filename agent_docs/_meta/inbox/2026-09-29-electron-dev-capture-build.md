---
target: build-pipeline
date: 2026-09-29
---

现象: 独立 Electron 开发包新增 WebGPU 抓帧 broker；build-pipeline 机制卡仍只描述旧的 Tauri 调试方式。
证据: scripts/electron_release.mjs 在 dev 档拷入 broker，src-electron/main.cjs 提供协议与本机 agent 接口；F2 单帧、连续帧和 agent 抓帧已在独立包真机通过。
建议: 更新 dev 包的 F2/agent 抓帧验收、项目外输出位置与 .wgpuc 分析方式，说明 RenderDoc .rdc 仍未接入。
