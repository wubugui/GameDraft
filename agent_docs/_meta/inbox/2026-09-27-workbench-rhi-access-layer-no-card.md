---
target: missing
date: 2026-09-27
session: wt/wbkit 工作台迁 RHI（燃烧工作台样板）
---

现象: 新增共用的「工作台 RHI 接入层」tools/workbench_rhi（vite 库模式打包 + 页面侧 WebGPU 宿主 + 空后端命令对照 + 真 Chrome 冒烟/自检），库里没有对应机制卡；burn-workbench / burn-system 卡已就地改成 WGSL 单一源。
证据: tools/workbench_rhi/README.md；tools/burn_workbench/gpu/burnView.test.ts；tools/burn_workbench/tests/test_parity.py（5/5 逐字节相同）。
建议: 建 editor-tools/mechanisms/workbench-rhi 卡，other workbenches 迁移时按 README「别的工作台怎么接」收编；shaderTwins.test.ts 的 burn 一对待 GLSL 删除后同步撤。
