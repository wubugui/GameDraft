---
id: dvc-oss-restore
title: 异地/新机 DVC 资源还原(勿用裸 dvc pull)
domain: meta
type: recipe
summary: 大文件还原钦定路径 = ./dev.sh pull;裸 dvc pull 在慢速直连下必挂且无配置面可救
status: active
authority:
  - scripts/sync-dvc-cache.py
  - tools/dev/__main__.py
triggers:
  topics: [DVC, OSS, 资源还原, 异地部署, 新机, dvc pull, 超时]
  tasks: [异地部署, 新机还原资源, 拉取大文件资源, 还原运行时媒体]
last_governed: 2026-08-05
---

**实测环境与日期**:2026-07-13,本机直连阿里云 OSS(约 ~367KB/s)完整性验证通过。

## 钦定路径

```bash
./dev.sh pull              # = git pull + DVC pull(内部走 scripts/sync-dvc-cache.py)
./dev.sh pull --editor     # 同时拉编辑器工程资源
# 等价壳:./scripts/pull-all.sh --editor
```

分工:DVC 只负责记录版本/校验 hash/本地 checkout;实际上传下载由 `sync.pull()`
(`tools/dev/__main__.py`,阿里云官方 `oss2` **同步** SDK + 多线程 + 断点续传)接管。

## 为什么不能用裸 dvc pull / dvc fetch

- **症状**:>20MB 的对象在慢速直连下一律 `failed to transfer` 空报错。远端数据完好,
  是客户端超时——**别去查数据坏没坏**。
- **根因**:dvc-oss 的异步栈(`aiooss2`)把 `connect_timeout` 当 aiohttp **总超时**用,
  且不认环境代理;`dvc_oss` 无超时透传旋钮,配置面救不了(故只能绕开,不能调参)。

## 相关

工程设施通则(dev.sh 收口、代理 7078、configure-oss)见项目 README「资源结构/日常开发」段。
