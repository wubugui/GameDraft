---
target: entity-lighting
date: 2026-07-22
session: 深度遮挡对齐实验室（billboard + 行走面脚点）
---

现象: 机制卡只记了 deferred 阴影踩过的「脚点锚必须与深度图同源，线性 floor 模型会产生系统性标定偏移」；同一病灶当时留在了另外三条路径上没修——角色/热点遮挡滤镜、planar 阴影落地面、`SceneDepthSystem.isCollision` 的碰撞格反投影，全都还在用 `floor_depth_A/B` 拟合直线当地面。实验室 2026-07-22 起把游戏遮挡深度改由 `character_lighting_lab` 导出（floor 线退化为 `np.polyfit` 最小二乘），该直线在多层街巷场景（雾津街头）中位偏离真实地面 0.67 深度单位 ≈ 211 行地面 ≈ 2.6 个人物深度跨度，站在可见地面上的站位有 4.7% 整块被吞、11.4% 重度缺角。
证据: 实验室权威口径 tools/character_lighting_lab/viewer/app.js:262-284（`dFront < uFootQ.z - .045`，注释明写「遮挡用相机平行 billboard @ 脚深度，着色才用直立 quad，拆开两个代理才能杀掉上半身 pop-through」）；游戏侧同一 `main()` 内 src/rendering/CharacterShadingFilter.ts 遮挡段用直线+倾斜面、着色段用 footQ；`lighting/ground_d.png`（= 实验室 `walk_depth`）早已随载荷进游戏并被 CharacterLightingSystem 逐帧双线性采样，但只喂了着色。修复后离线复核：雾津街头「可见地面站位」全遮挡 4.7%→0.4%、重度 11.4%→2.1%；碰撞判定有 5~6% 屏幕像素改判（原先读错格）。
建议: 机制卡把「脚点锚同源」升格为跨全部消费点的不变量（遮挡/阴影/碰撞三处并列写清），并补一条「遮挡与着色是两个代理，禁止合并」；同时记下运行时新增的 `SceneDepthSystem.setGroundDepthField` 注入口与 `IEntityShadow.setGroundFootDepth`，以及无烘焙场景仍回落旧直线口径这一分叉。另留两条待办：F10 调试改世界尺寸时 `CharacterLightingSystem.sceneWorldW/H` 未同步（footQ 会漂）；`export_runtime` 的 `version=1→2` 属工作区未提交改动，常驻 serve.py 进程不重启会持续导出被运行时静默丢弃的 v1 载荷。
