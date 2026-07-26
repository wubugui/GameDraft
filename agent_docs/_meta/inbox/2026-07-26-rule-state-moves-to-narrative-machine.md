---
target: content-norms
date: 2026-07-26
session: 核心玩法象理术访谈
---

现象: content/norms.md 与规矩相关口径仍以 FlagStore(`rule_<id>_acquired` / `rule_<id>_<层>_done`)为规矩状态载体,制作人当面否决——该路径已废弃,规矩状态一律走叙事状态机(一条规矩 = 一张叙事图,世界侧读 narrative 叶子)。
证据: 本会话制作人原话「这套东西彻底废弃了,现在要看叙事状态机」;`NarrativeOwnerType`(src/core/NarrativeStateManager.ts:18) 当前无 `rule`,是待开的口子;定稿见 artifact/Design/核心玩法-象理术-方案-2026-07-26.md §9。
建议: 蒸馏时把 norms 的规矩状态口径改成 narrative-owner 模型,并考虑新增一张「规矩即叙事图」机制卡。
