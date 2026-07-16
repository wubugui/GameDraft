---
target: asset-pipeline-norms
date: 2026-07-16
session: unified-animation-workbench
---

现象: 规范曾要求角色原始素材目录只能有 setup.png/mp4，但新统一工作台必须在同一角色目录保存受管、不可变的全阶段历史。
证据: `tools/anim_preview/workspaceStore.mjs` 的落盘根为 `tmp/原始素材/<角色>/animation-workbench/`，与旧 `agent_docs/asset-pipeline/norms.md` 第 6 条字面冲突。
建议: 保留归档根目录“只放定稿”红线，同时把受管 `animation-workbench/` 明定为唯一例外并禁止手工编辑。
