---
id: shared-tree-and-worktrees
title: 多会话共用主工作树 / 另开 worktree 的操作口径
domain: meta
type: recipe
summary: 主工作树常年有多个会话并行改且堆着别人未提交的改动——莫名的失败先当别人的、禁 git stash、add -A 前先认真实基线;另开 worktree 要补 venv 与 DVC junction、dev server 在 worktree 里看不见改动
status: active
authority:
  - vite.config.ts#DEV_WATCH_IGNORED
  - tools/testing/repo_write_guard.py
  - scripts/dev_agent.cjs
  - resources/editor_projects.dvc
  - resources/audio_sources.dvc
  - resources/vendor_archives.dvc
triggers:
  topics: [并行会话, 工作树, worktree, git stash, 提交, 基线, junction, 假失败]
  tasks: [提交所有改动, 开 worktree, 判断是不是我引入的失败, 跑基线对比, 在 worktree 里验运行时改动]
last_governed: 2026-09-23
---

**实测环境与日期**:2026-09-03/04 并行会话半落地的 import 打断测试;2026-09-08 `add -A` 险些回退三个已推送提交;
2026-09-21 stash 两次误判 + worktree 里 dev server 发旧模块。

## 主工作树是共用的

制作人常同时开 2–3 个会话改同一棵树(无隔离),树里长期堆着别人未提交的数据改动。

- **两次自己的测试之间冒出来、又对不上自己任何改动的失败,多半是别的会话改到一半**(先看最近几分钟被改过的文件)。
  别去"修"别人没落完的代码,也别回滚不是自己改的文件;自己的改动用精确局部替换,两边的改动才能在同一文件里共存。
- **判"这条失败是不是我引入的"**:先看失败指向的文件在不在自己的改动清单里;不在就把它和
  `git show HEAD:<file>` 比,看是不是别人未提交的改动。基本当场定论,**不需要动工作树**。
- **禁用 `git stash`**(含带未跟踪文件的变体):它藏的是整棵树(连别人的改动一起),于是"基线"其实是 HEAD;
  stash/pop 期间正在跑的后台测试会读到半还原的树,报一串撞车式假失败;它还改 mtime,事后分不清谁动过。
  真要跑基线就另开 worktree(见下)。**后台有测试在跑时别碰工作树**。

## 提交全部改动前先认真实基线

别的 worktree 会推 master,主树又常被 `reset` 挪 HEAD 而盘上内容没跟上——此时**别人新增的文件在
`git status` 里长得和"我删了"一模一样**,`add -A` 会静默回退已推送的提交,零告警。

1. `git reflog` 看最近有没有 `reset:`,`git worktree list` 看有没有别的树在推。
2. 拿候选提交逐个 `git diff --stat`,**能让那批"删除项"消失的那个才是真基线**。
3. 不动工作树地把盘上内容快照成那个基线的子提交(临时索引 + `add -A .`——**要带 `.`**,否则未跟踪文件会漏进不了快照),
   在临时 worktree 里与 HEAD 合并、看冲突,再落地。
4. **验收判据**:`git diff --diff-filter=D --name-only <合并前 HEAD> HEAD` 必须为空——相对已推送的 master 一个文件都不许消失。

## 另开 worktree

`git worktree add` 只给 git 跟踪的文件,**venv 与全部 DVC 资产都不在**;不补就是一片"看着像代码坏了"的假失败。

- 补 junction 指回主仓同名路径:`.tools`,以及四个 DVC 目录 `public/resources/runtime`、`resources/editor_projects`、
  `resources/audio_sources`、`resources/vendor_archives`(worktree 里只有 `.dvc` 指针文件)。补完 `git status` 仍干净。
  拆 junction 只删链接本身,**别用递归删除**——会删到主仓数据。
- worktree 里跑 pytest 加 `-p no:cacheprovider`:仓库写保护会挡 `.pytest_cache`,换名重试到上限、卡到兜底强杀,汇总行被吞。
  编辑器测试门的口径以 [editor-change-verification-gate](../../editor-tools/recipes/editor-change-verification-gate.md) 为准。
- **worktree 里起的 dev server 看不见改动**:worktree 根在 `.claude/` 下,而 dev 监听的忽略表里有 `.claude/**`
  ⇒ 整棵树被忽略,改了不生效、重载拿旧模块、不报错。每次改完**杀掉重起**(用 `scripts/dev_agent.cjs` 指定独立端口)。
  编辑器/客户端里"一键起预览"的入口多半是在**主仓根**起的,跑的是主仓游戏,不是 worktree。
- 要给 worktree 加一个新场景资源目录又不写主仓:把 `public/resources/runtime` 那条 junction 换成真目录,
  里面逐个子目录 junction 回主仓,新目录再单独放。
