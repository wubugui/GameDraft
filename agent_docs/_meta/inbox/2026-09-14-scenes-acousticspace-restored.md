---
target: scene-acoustics
date: 2026-09-14
session: editor-test-triage
---

现象: 接 `2026-09-11-scenes-lost-acousticspace`：6 个场景的 `acousticSpace` 丢失已随 8dc0a3d 提交进 HEAD，两条自检一直红。
证据: 8dc0a3d 里这 6 个文件的改动 = 删掉 `acousticSpace`（跑马梁还有 `acousticListener`）+ 文末追加 depthConfig，别无其它，像一次基于旧底稿的整文件改写；同一提交里 acoustic_spaces.json v2 的 `authoring.sceneId` 恰好指着这些场景，运行时 SceneManager 仍只从场景 JSON 读绑定；没有任何记录说是有意去掉的。
处理: 2026-09-14 按 1d076eb 的原值补回 6 条 `acousticSpace`；跑马梁的 `acousticListener: camera` **没补**（v2 里空间自带 `listenerBinding: player`，场景覆盖会盖掉工作台里调的听者，要不要恢复待制作人定）。
