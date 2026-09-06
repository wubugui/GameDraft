---
target: missing
date: 2026-09-06
---
现象: 象理术方案要求规矩拥有独立叙事状态，原有碎片/授予模型不能表达当前正文与成色变化；本批新增可选 narrativeStates 及唯一 rule owner。
证据: docs/玩法功能需求清单.md E2、src/core/ruleKnowledgeValidation.ts、src/systems/RulesManager.ts、artifact/OpenWorld/rules-pointer-input-evidence.json；状态改名和编辑器保存同步维护映射。
建议: 补充规矩知识机制卡，区分旧碎片兼容模式与新原生投影，未知层不露出，不能把物品给予当知识验证。
