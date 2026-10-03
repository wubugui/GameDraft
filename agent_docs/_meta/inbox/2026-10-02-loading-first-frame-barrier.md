---
target: vfx-rendering
date: 2026-10-02
---
现象：机制卡要求所有管线和预热在揭幕前完成，但当前揭幕闸未覆盖 VFX 视图首次创建、首次 GPU 上传及异步挂件重挂；不能证明目标完整首帧已提交。
证据：Game.setRevealGate 并行等待 pipelinesReady 与 prepareForReveal；SceneTransition 暂停 VfxSystem.update，VfxRenderer.ensureView 在真正 render 才建视图；普通切场还真跑确认淡揭中玩家逻辑与显示坐标不一致，见 artifact/Reviews/loading-audit-20261002/。
建议：机制卡区分模拟预热、已建管线等待与完整首帧屏障；加载所有者应准备全部视图、同步位置并在遮罩下提交完整帧，失败与取消返回明确结果。
