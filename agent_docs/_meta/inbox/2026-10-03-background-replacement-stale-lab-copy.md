---
target: scene-bake-downstream
date: 2026-10-03
---

现象: 同名替换背景后 redo_depth 完成新图烘焙，却在 export_runtime 被像素一致性闸门拦住；build 只在工作目录 background.png 不存在时更新输入副本，已有副本仍是旧图。
证据: tools/character_lighting_lab/pipeline.py:1801、1959；local/hesha-replace-20261003/redo-level.log 与 export-recovery.log。新 manifest.hash/native 已对应 1536×2048 新图，旧工作副本仍为 2048×1152；核实哈希后刷新副本并重试两个正式导出入口成功，再以 redo_depth --skip pin,build 续跑全部下游。
建议: 同名换图的流程补充工作副本刷新与输入哈希检查，避免完成高成本烘焙后才因旧副本拒绝导出；不要绕过像素一致性闸门或重算已完成的 probe。
