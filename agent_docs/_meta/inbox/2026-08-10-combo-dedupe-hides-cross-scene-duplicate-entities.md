---
target: shared-widget-value-fidelity
date: 2026-08-10
session: 头顶闲聊说话人改造（bubble_lines 两档表单）
---

现象: 「选择器铁律」只说了"大候选集一律弹窗"，没说**下拉去重会让一部分实体彻底选不到**。
`bubble_lines_editor` 原先把全工程 198 个实体拉平进一个 `IdRefSelector`（本体是 QComboBox），
并按"同 id 跨场景只留第一次出现"去重——工程里实测有 24 个跨场景重名 id
（`npc_dream_old_man` 在梦_农家院/梦_里屋/梦_饭屋 三处、`new_npc_0` 五处、teahouse 一整排
`fx_*` 在 dev_teahouse_alive 也有），于是"另外那两个"在 UI 上不存在，且**没有任何提示**。
证据: `python3` 扫 `public/assets/scenes/*.json` 得 198 实体 / 24 组跨场景重名；去重逻辑见改动前
`bubble_lines_editor._reload_ref_candidates` 的注释"同 id 跨场景只留第一次出现"。
建议: 在保值契约那张卡上补一句——**去重不是保值问题、是可达性问题**：候选集里"同 id 不同物"
的场合，选择器必须携带消歧维度（本例改成 `(场景, 实体)` 二元组的地图选点弹窗），
否则策划配出来的引用永远指向第一个同名者，运行时按当前场景解析＝整组静默不响。
