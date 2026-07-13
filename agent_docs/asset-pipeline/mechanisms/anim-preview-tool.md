---
id: anim-preview-tool
title: 动画预览工具(tools/anim_preview)
domain: asset-pipeline
type: mechanism
summary: 产完动画在哪验收:复用游戏真 SpriteEntity 逐像素一致渲染 + 运行时实时扫描发现全部动画(不能用构建期 glob)
status: active
authority:
  - tools/anim_preview/animScanPlugin.ts
  - tools/anim_preview/__main__.py
  - package.json#dev:anim-preview
triggers:
  paths: ["tools/anim_preview/**"]
  topics: [动画预览, anim preview, 动画验收]
  tasks: [验收动画, 预览动画, 改预览工具]
last_governed: 2026-07-11
---

## 是什么(一句话)

独立 Web 工具(vite dev):渲染用游戏**真** `src/rendering/SpriteEntity.ts` +
`normalizeAnimationSetDef`,和游戏逐像素一致——不是重实现;产线出新角色后在这里目验。

## 权威源(读代码从哪进)

- `animScanPlugin.ts`:发现机制核心(`GET /api/anim/index` 现扫
  `public/resources/runtime/animation/*/anim.json` + 文件 watcher 经 vite WS 推 `anim:changed`)
- `__main__.py`:启动器(起 vite + 开浏览器,`--char/--state`);入口注册在 dev 总控台
  (`tools/dev_console/app.py` 的 TOOLS)与 `package.json` 的 `dev:anim-preview`
- deep-link:`?char=<id>&state=<state>`

## 硬契约(违反即 bug)

- **发现必须是运行时 fs 扫描 + 监听,不能改回 `import.meta.glob`**:动画在 `public/` 下是静态
  资源、不在 vite 模块图里,glob 命中不了;且 glob 是构建期静态,新增目录进不来。
- atlas.png 变更必须 cache-bust(URL 挂 `?v=<mtime>` + 重 loadFromDef),否则看的是旧图。
- 为工具加游戏侧能力只允许 additive(如 SpriteEntity 的 scrub/逐帧 getter),不改游戏行为。
- 场景背景模式铁律:**角色保持舒适大小(≈屏高 55%),背景按同一世界比例放大、镜头怼在
  spawn 上只显示一块**——不是把整场景塞进画面(会把角色缩成芝麻,被用户明确否过)。

## 已知坑

- 浮动设置面板必须是 fixed 居中 modal,固定像素偏移的 absolute 浮层会随分辨率乱飘遮控件。

## 怎么验证

起工具后丢一个新 bundle 进 `public/resources/runtime/animation/`,列表应不刷新页自动 +1。
