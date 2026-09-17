---
target: vfx-workbench
date: 2026-09-15
---
现象: 机制卡仍描述整份工作态布置库顶替运行时；此行为会让未编辑场景的缓存参与保存和预览，本次已修复为实际编辑的场景 × 时段外观范围。
证据: viewer/app.js 的 changedPlacementLibrary、placements.py 的 save_changes，以及 scoped-save-selftest.js 的真实页面回归；保存仅接收 changes，预览要求 mode=scoped；缺省范围保留磁盘内容，显式 [] 才清空。
建议: 更新机制卡的整库提交与丢弃预览描述，并注明旧桌面进程需要重启以加载新保存接口；旧协议禁止猜测编辑范围。
