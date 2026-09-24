---
id: dvc-oss-restore
title: 异地/新机 DVC 资源还原(勿用裸 dvc pull)
domain: meta
type: recipe
summary: 大文件还原/推送钦定路径 = tools.dev pull / push(内部走 sync-dvc-cache.py);裸 dvc pull 在慢速直连下必挂、裸 dvc push 对 OSS 必失败,都不是网络问题
status: active
authority:
  - scripts/sync-dvc-cache.py
  - tools/dev/sync.py
  - tools/dev/__main__.py
triggers:
  topics: [DVC, OSS, 资源还原, 异地部署, 新机, dvc pull, dvc push, 超时, AsyncPayload]
  tasks: [异地部署, 新机还原资源, 拉取大文件资源, 还原运行时媒体, 推送大文件资源]
last_governed: 2026-09-23
---

**实测环境与日期**:2026-07-13,本机直连阿里云 OSS(约 ~367KB/s)完整性验证通过;2026-09-08 / 09-11 推送侧两处必现故障实测。

**Windows 上 `./dev.sh` 起不来**,下面每条换成 `.tools/venv/Scripts/python.exe -m tools.dev <同名任务>`
(见 [windows-dev-environment](windows-dev-environment.md))。

## 钦定路径

```bash
./dev.sh pull              # = git pull + DVC pull(内部走 scripts/sync-dvc-cache.py)
./dev.sh pull --editor     # 同时拉编辑器工程资源
./dev.sh pull --audio      # 同时拉两份音频素材库(~270MB)
./dev.sh init-audio        # 只补这两份(不 git pull),等价于换机后单独补它们
# 等价壳:./scripts/pull-all.sh --editor(壳里已带 --editor,再加 --audio 即可)
```

拉取分三挡,**默认集只有跑游戏必需的 vendor + runtime**:

| 挡位 | 多拉什么 | 谁需要 |
|---|---|---|
| 默认 | — | 跑游戏、改数据 |
| `--editor` | `resources/editor_projects` | 开编辑器工程(`pull-all.sh` 无条件带) |
| `--audio` | `resources/audio_sources`(~70MB,不可再生)<br>`tools/audio_editor/imported`(~200MB,抽卡产物,重生成要花钱且不可复现) | 用 `tools/voice_workbench` 重录/重导配音;用 `tools/audio_editor` 挑音效候选 |

这两份单独一挡而不是并进 `--editor`:后者被 `pull-all.sh` 无条件带上,并进去就等于
把 270MB 变成事实上的默认拉取。两个工作台在源库缺席时按设计如实报「源不在本机」而非坏掉,
所以缺它们不是故障态。

两份共用一个开关而不是各开一个:都是"只有音频工作侧要"的大素材,拆开只会让人记不住
哪个开关带哪个。

## 通则:接进写侧就必须同时接进读侧

**一份资源接进写侧(push / commit)的那一刻,必须同时接进读侧(pull)与"没有它也能活"
的路径。** 只补一半的后果不是"拉不到"——是**别人在完全无关的操作上崩**:push 侧要展开
该目标的缓存清单,缓存里没有就是裸报错;`dvc add` 对不存在的目录同样直接退出。
于是"我只改了代码"的人一 push 就挂,挂点跟他改的东西毫无关系。
新增 DVC 目标时,读侧 / 写侧 / 缺席可活 / 对应测试**四处一起改**,别只改能跑通自己那一步的两处。

**没拉过某一挡的机器照样能 push / commit**:`sync.push()` 按本机 DVC 缓存过滤目标、
`sync.commit()` 按工作区目录是否存在过滤 `dvc add`,跳过的那份会打印一行说明。
(过滤之前会炸:push 侧要展开该目标的 `.dir` 缓存清单,缓存里没有就是裸
`FileNotFoundError`;`dvc add` 对不存在的目录直接报错退出。)

分工:DVC 只负责记录版本/校验 hash/本地 checkout;实际上传下载由 `sync.pull()`
(`tools/dev/sync.py`,阿里云官方 `oss2` **同步** SDK + 多线程 + 断点续传)接管。

## 为什么不能用裸 dvc pull / dvc fetch

- **症状**:>20MB 的对象在慢速直连下一律 `failed to transfer` 空报错。远端数据完好,
  是客户端超时——**别去查数据坏没坏**。
- **根因**:dvc-oss 的异步栈(`aiooss2`)把 `connect_timeout` 当 aiohttp **总超时**用,
  且不认环境代理;`dvc_oss` 无超时透传旋钮,配置面救不了(故只能绕开,不能调参)。

## 推送:别用裸 dvc push

- **钦定 = `tools.dev push`**(内部 `scripts/sync-dvc-cache.py push`,同步 SDK、按对象查远端已有就跳过;实测四千多个对象查完约一分钟)。
- **裸 `dvc push` 对 OSS 每个对象都必失败**,报 `Can't instantiate abstract class AsyncPayload with abstract method decode`:
  约束集钉的 aiohttp(3.12 起 `Payload.decode` 成了抽象方法)与 dvc-oss 用的异步 OSS 适配层(最新版也只实现了 `write`)不兼容。
  长得像传输抖动,**实际一个字节都没发出去,重试、查 endpoint / 凭证都没用**。
  大文件分片路径还有第二处必现错误(`'coroutine' object has no attribute 'parts'`)。
- 只想用 dvc 自己做验收(`dvc status -c` 应输出 in sync)时,可在进程内给那个适配类补一个抛错的 `decode`
  **并清空它的 `__abstractmethods__`**(只挂方法不清集合照样实例化失败)再调 `dvc.cli.main`;上传路径不调 `decode`。
  **别改共享 venv**。根治(钉回 aiohttp < 3.12 或包一层)要改受控依赖集,先问制作人。

## 相关

工程设施通则(dev.sh 收口、代理 7078、configure-oss)见项目 README「资源结构/日常开发」段。
