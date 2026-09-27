---
target: acoustic-workbench
date: 2026-09-27
session: wt/view3d（四台 view3d 迁到工作台 RHI 接入层的 3D 调试件）
---

现象: 声学 / 轨迹 / 粒子 / 地形四张工作台卡仍写 view3d.js 是「裸 WebGL2 渲染」、`--selftest` 在 ANGLE/SwiftShader-WebGL 下连 3D 一起测；现在四台 3D 着色走 `tools/workbench_rhi/debug3d.ts`（RHI / WebGPU，着色器只有 debug3d.wgsl），离屏 Qt 拿不到 WebGPU 时 S1g 记 SKIP，着色层的真跑在各台 pytest 的 Chrome 那条里。
证据: tools/workbench_rhi/README.md「3D 调试件」一节；tools/*_workbench/tests/test_selftest.py 的 test_selftest_in_chrome_with_real_webgpu；vitest tools/workbench_rhi/debug3d.test.ts。
建议: acoustic-workbench / trajectory-workbench / vfx-workbench / terrain-workbench 四卡的 view3d 与自检描述改指 3D 调试件；另记一坑：luma 依赖的 probe.gl 求值时无条件写 globalThis.probe，会盖掉页面同名全局（声学台「试听」），接入层包要先记后还（debug3dGlobals.ts）。
