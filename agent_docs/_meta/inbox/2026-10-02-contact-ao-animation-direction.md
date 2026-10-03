---
target: entity-lighting
date: 2026-10-02
---

现象: 制作人新增逐动画 contactAoEnabled（缺省仅 idle/crouch 开），AO 方向改为角色 contactAo.direction 覆盖场景 contactAoDirection，两层均支持自动/手动；手动仰角 1~90°，自动仍保留 25° 下限，旧机制卡尚未涵盖。
证据: src/data/animationContactAoDefaults.json、src/core/Game.ts 的 contactAoParams、tools/editor/editors/contact_ao_ui.py；真机矩阵与像素证据 artifact/ao-settings-20261002/runtime-verification.json。
建议: 补充两层优先级、逐动画门控、手动屏幕拖尾方向（0右/90下）及 CPU/GPU 同时放开手动仰角的契约；旧显式 dirSource 保留为角色覆盖。
