---
target: narrative-state-editor
date: 2026-07-26
session: 规矩系统迁移 Phase 0-3
---

现象: 机制卡与迁移方案都假定「wrapper 必须绑 owner」意味着要新增 NarrativeOwnerType，实测只要**元素**上有非空 ownerId 即可，ownerType 留空在 TS/Python 两侧都被短路跳过——于是规矩层图零新增 owner 类型、零校验豁免、也不触发 getPrimaryGraphByOwner 的多 wrapper 歧义。
证据: tools/editor/editors/narrative_state_editor.py:2014-2018（只查 el.ownerId，ownerType 空则跳过）；src/core/narrativeGraphValidation.ts:194（`el.ownerType &&` 短路）、:630（`if (!ownerType || !ownerId || !gid) continue`）；落地见 tools/editor/shared/rule_graph_sync.py::build_rule_ledger_composition。
建议: 在 narrative-state-editor 机制卡里写明「wrapper 绑定的硬要求只有元素级 ownerId；ownerType 是可选的运行时索引开关」，避免以后再有人为了挂一批派生图去扩 NarrativeOwnerType。
