---
target: build-pipeline
date: 2026-09-27
session: engine2d/RHI 迁移 · Qt 宿主上 WebGPU(wt/qthosts)
---

现象: public/resources/runtime 是 junction(子代理 worktree、D:/GameDraft-rhi 都这么链)时,asset_manifest 的 _public_rel 先 resolve 再 relative_to,链接后面的文件全部掉出清单(1917 → 366),scene_sweep 随之报 185 条假漏抽。
证据: tools/build/asset_manifest.py#_public_rel;同一棵树打补丁后清单 1917、全量扫描 0 漏抽(F:/gd_wt/qthosts_out/sweep-full.json)。
建议: _public_rel 不 resolve 链接(或同时认 public 下的链接目标),或验收门在清单文件数骤降时报错。
