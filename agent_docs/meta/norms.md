---
id: meta-norms
title: 跨域工作规范
domain: meta
type: norm
summary: 任务分类闸门、四个存放面边界、列举型以代码为准、偏差记录义务
status: active
triggers:
  tasks: [任务分类, 开工, 跨域改动, 系统设计]
  topics: [分类, 存放面, 文档漂移, 偏差记录]
last_governed: 2026-07-11
---

# 跨域工作规范

## 不变量

1. **先分类再动手**:任何任务先判定工作类型——做内容(改 JSON)/不改玩法的技术改动/
   改编辑器工具/改玩法设计含义/架构盘点——按对应域规范工作;拿不准先判类型,
   任何一类都不把小需求扩成大重构。(现行分类闸门见项目根 CLAUDE.md §0)
2. **玩法含义改动先过文档**:会改变玩家可见规则/结果/资源流/进度的改动,先改
   `docs/玩法功能需求清单.md` 对齐;冲突先停下报告,再动实现。
3. **列举型事实以代码为准**:文档与记忆中的清单类内容(动作清单、状态枚举、条件叶子、
   系统列表)默认漂移;用前查代码权威源,不照抄文档里的表。
4. **四个存放面不混放**:项目契约→本库;可执行流程→`.cursor/skills/`;时效性工作产物
   (计划/审查/任务书)→`artifact/`;个人偏好→agent 私有记忆。人看的设计文档在 `docs/`,
   与本库重叠部分迁入后旧址立牌,不留双源。

## 过程义务

1. **开工按触发面读库**:按任务读 `agent_docs/INDEX.md` 对应域条目;按将改动的文件跑
   `python3 agent_docs/_meta/audit.py --paths <files...>` 取必读卡。
2. **系统设计先访谈**:制作人留白的系统性设计走[制作人协作法](methods/producer-collab-unknowns.md),
   禁拿行业最佳实践填空。
3. **偏差记录义务**:工作中发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,不需审批,格式见该目录 README)。

## 验收门

- 跨域改动叠加适用所涉各域 norms 的验收门;
- 动过本库后 `python3 agent_docs/_meta/audit.py` 零 error。

## 红线

- CLAUDE.md 不得擅改(路由器化接线未获批准,见 _meta/governance-log.md);
- `INDEX.md` / `paths-triggers.json` 是生成物,禁止手写;
- 治理与建库只写 `agent_docs/**`,库外仅允许旧址立牌。
