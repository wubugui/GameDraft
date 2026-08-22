---
target: dvc-oss-restore
date: 2026-08-19
session: 修 tools/dev/sync.py 的 audio_sources 拉/推不对称
---

# audio_sources 进了 push/commit 却没进任何拉取通道

- **现象**：`resources/audio_sources.dvc`（配音音源，70MB/18 文件）在 `sync.push()` 与
  `COMMIT_DVC_ADD_PATHS` 里是一等目标，但 `sync.pull()` 只拉 vendor/runtime/(--editor)editor。
  新机跑钦定的 `scripts/pull-all.sh` 永远拿不到它，`dvc status` 恒报 `not in cache`。
  同一次遗漏还留下一条**红测试**：`test_push_checks_and_uploads_all_dvc_targets` 仍断言
  三目标元组，而实现已推四个（登记面改了一半）。
- **根因**：2026-08-19 前两次提交（5be2700 登记音源、72a6637 接进 push/commit 链路）
  只补了写侧，没补读侧，也没补测试。`scripts/sync-dvc-cache.py` 的 `DEFAULT_DVCFILES`
  四个都在，所以不对称只存在于 `tools/dev/sync.py` 这一处。
- **影响**：比"拉不到"更狠的是**没拉过就 push 会炸**——push 侧要展开该目标的 `.dir`
  缓存清单（`collect_required_oids_from_local`），缓存里没有就是裸 `FileNotFoundError`；
  `commit` 侧 `dvc add` 对不存在的目录同样直接报错退出。也就是说，任何只拉默认集的新机
  一旦 push/commit 就必挂，而挂点跟"我只改了代码"毫无关系。

## 2026-08-19 已修

音源定为**独立可选挡** `--audio`（+ `./dev.sh init-audio`），不并进 `--editor`——
`pull-all.sh` 无条件带 `--editor`，并进去等于把 70MB 变成事实上的默认拉取。
配套把 push/commit 改成按"本机真有的"过滤目标并打印跳过项，`bootstrap.CLEAN_PATHS`
补齐四个 DVC 工作区目录（漏一个就会留下"目录还在、缓存已清空"的半残态，正好触发上面那条炸点）。

留给知识库的那句话：**一份资源接进写侧（push/commit）就必须同时接进读侧（pull）与
"没有它也能活"的路径**——只补一半的后果不是"拉不到"，是别人在完全无关的操作上崩。
