---
id: agent-surface-map
title: agent 存放面地图(知识真源 vs 客户端壳)
domain: meta
type: mechanism
summary: 各 AI 客户端目录都是曝光/执行壳而非存放面;只有 agent-docs-cli 薄壳自动维护,其余镜像靠人工、已经漂了
status: active
authority:
  - agent_docs/_meta/cli.py
  - .cursor/skills
  - .claude/agents
triggers:
  paths: [".cursor/skills/**", ".claude/**", "agent_docs/_meta/cli.py"]
  topics: [存放面, skill, subagent, symlink, 客户端曝光]
  tasks: [新增skill, 新增subagent, 客户端接线, 治理接线]
last_governed: 2026-08-05
---

## 是什么(一句话)

norms 不变量④的四个存放面管的是**知识归谁存**;各 AI 客户端目录(`.cursor/skills/`、
`.claude/skills/`、`.claude/agents/`)管的是**同一批流程壳暴露给谁**,是投影不是新存放面。

## 权威源(读代码从哪进)

`agent_docs/_meta/cli.py` 的 `KNOWN_CLIENTS` + `install` = 唯一自动维护的接线;
其余曝光面无程序管辖,现状只能直接 `ls` 那三个目录。

## 硬契约(违反即 bug 的机制约束)

- **壳不存知识**:客户端目录里的 SKILL.md / subagent 定义只写"怎么做"和入口指针,
  "是什么/为什么"一律指回本库,不得复制正文——复制即双源,漂移无人发现。
- **`.cursor/skills/` 是流程壳的真文件**,其它客户端目录只是它的镜像;改流程改 `.cursor` 侧。
- **`cli.py install` 管辖的三项**(agent-docs-cli 薄壳 / CLAUDE.md 闸门块 /
  `.claude/settings.json` hook)幂等自愈,不手改。

## 已知坑

- **镜像手工维护、已经漂了**:`.claude/skills/` 靠「目录 + SKILL.md 逐文件 symlink」镜像
  `.cursor` 侧,`cli.py` 不管它 → 新增 skill 不补 symlink 则该客户端**静默看不见**
  (2026-08-05 实测:15 个 .cursor skill 只镜像了 9 个)。
- **symlink 是文件级不是目录级**:skill 若长出 SKILL.md 之外的附属文件(references/ 等),
  镜像侧同样看不到,须逐个补。
- **skill/workflow 治理审计把镜像对报成 possible-overlap**:by-design,勿当问题修。

## 怎么验证

```bash
comm -23 <(ls .cursor/skills | sort) <(ls .claude/skills | sort)   # 漏镜像的 skill
sh scripts/py.sh agent_docs/_meta/cli.py install                   # CLI 管辖项幂等自检
```
