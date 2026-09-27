---
name: 提交项目
description: 一键把 GameDraft 主工作树的全部改动提交并推送——认基线 → 刷新全部 DVC 指针(dvc add)→ git add -A 提交(含 .dvc)→ tools.dev push 把 DVC 对象传上 OSS 并 git push → 复核远端零缺口。触发词：提交项目、提交所有东西、全部提交并推送、提交并同步 dvc、一键提交、commit all and push。与 Cursor 侧 commit-push-gamedraft(选择性提交)不同，本技能是全量。
---

# 提交项目(全量提交 + DVC 彻底同步 + 推送)

用户调起本技能 = 已授权**提交工作树里的全部改动并推送**(git + DVC),中途不再逐步确认。
只有下面写明「停下」的情形才停下报告。

为什么这么做(基线陷阱、裸 `dvc push` 必失败)见库内配方,以库为准:
- `agent_docs/meta/recipes/shared-tree-and-worktrees.md`「提交全部改动前先认真实基线」
- `agent_docs/meta/recipes/dvc-oss-restore.md`「推送:别用裸 dvc push」

下文 `PY` = `.tools/venv/Scripts/python.exe`(Unix 为 `.tools/venv/bin/python`)。**不用** PATH 上的 `dvc`,
**不用**裸 `dvc push` / `dvc pull`。命令都在仓库根跑(Bash 工具)。

## 1. 认基线

```bash
git fetch origin
git status -sb | head -1
git reflog -10
git worktree list
```

- `reflog` 里有 `reset: moving to <别的提交>`(不是 `moving to HEAD`)→ **停下**,按基线配方第 2–4 步处理,别直接 `add -A`。
- 本地落后 `origin/master`(别的 worktree 推过)→ 照常提交,第 5 步推送前先 `git merge origin/master`;有冲突 → **停下**报告。
- 记下提交前的 `origin/master` 哈希,第 6 步验收要用。

## 2. 看清要提交什么

```bash
git status --porcelain | awk '{print $1}' | sort | uniq -c
git status --porcelain | grep '^ D' | grep -v 'agent_docs/_meta/inbox'
```

- 每个删除项都要查清:是改名/拆分(有对应的新文件)还是别人加的文件被当成删除了。后者说明基线不对 → **停下**。
  `agent_docs/_meta/inbox/` 的删除是治理收编,正常。
- 未跟踪文件里有 > 5MB 的大文件 → **停下**问:它该进 DVC 目录而不是 git。
- 密钥/凭据文件(`.env*`、`.tools/oss.env` 等)出现在待提交里 → **停下**。

## 3. 刷新全部 DVC 指针

目标清单以代码为准(`tools/dev/sync.py` 的 `COMMIT_DVC_ADD_PATHS`),本机不存在的目录跳过:

```bash
PY=.tools/venv/Scripts/python.exe
$PY -m dvc status
P=$($PY -c "from tools.dev.sync import COMMIT_DVC_ADD_PATHS as p; import os; print(' '.join(x for x in p if os.path.exists(x)))")
$PY -m dvc add $P
$PY -m dvc status          # 期望 Data and pipelines are up to date.
git status --short -- '*.dvc'
```

记下哪几个 `.dvc` 变了,汇报用。

## 4. 全量提交

```bash
git add -A
git diff --cached --stat | tail -1
git diff --cached --name-only | awk -F/ '{print $1"/"$2"/"$3}' | sort | uniq -c | sort -rn | head -40
```

按暂存内容写提交信息,沿用仓库惯例(`git log --oneline -5` 对齐口径):

```
feat(全量): <主要改动 1> / <主要改动 2> / ... —— 主工作树 <上次提交日期 MM-DD>~<今天 MM-DD> 累积改动

Co-Authored-By: <按会话 system-reminder 给的署名行>
```

改动主题从目录分布和新增文件名里归纳,用中文、用制作人认得的名字(系统/工作台/玩法),不列文件名。
用 heredoc `git commit -F -` 提交;不加 `--no-verify`,hook 失败就查原因。

## 5. 推送(DVC 对象 + git)

```bash
PYTHONIOENCODING=utf-8 .tools/venv/Scripts/python.exe -m tools.dev push 2>&1 | tail -40
```

内部顺序:`dvc status` → `scripts/sync-dvc-cache.py push`(oss2,远端已有的跳过)→ `git push`。
耗时可能几分钟,给足 timeout(600000)。git 走不通需要代理时加 `--git-proxy <地址>`,**不许**改用裸 `dvc push`。
失败 → 原样报告输出,不要反复重试。

## 6. 复核(三条都要过)

```bash
PYTHONIOENCODING=utf-8 .tools/venv/Scripts/python.exe scripts/sync-dvc-cache.py push \
  $(.tools/venv/Scripts/python.exe -c "from tools.dev.sync import ALL_DVC_TARGETS as t; import os; print(' '.join(x for x in t if os.path.exists(x)))")
git status -sb | head -1
git diff --diff-filter=D --name-only <第1步记下的 origin/master> HEAD | grep -v 'agent_docs/_meta/inbox'
```

1. DVC 二次同步输出 `0 uploaded`——远端对象齐全。
2. `## master...origin/master`,没有 ahead/behind,工作树干净。
3. 删除列表只剩第 2 步查过的改名/拆分项。

## 7. 汇报(中文，给制作人)

- 提交哈希、文件数、推到了哪(`旧..新`)。
- DVC:哪几个 `.dvc` 指针变了;上传多少个新对象 / 共检查多少个;二次同步 0 上传。
- 删除项各是什么(改名到哪)。
- 固定提醒一句:主工作树有别的会话在并行改,全量提交会把当时磁盘上所有会话的改动(含改到一半的)一起打进去。
