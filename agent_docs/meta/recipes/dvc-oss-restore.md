---
id: dvc-oss-restore
title: 异地/新机 DVC 资源还原(勿用裸 dvc pull)
domain: meta
type: recipe
summary: 大文件资源还原钦定路径 = ./dev.sh pull(oss2 SDK+多线程+断点续传);裸 dvc pull/fetch 在慢速直连下必挂(dvc-oss 异步栈把 connect_timeout 当总超时且不认代理)
status: active
authority:
  - scripts/sync-dvc-cache.py
  - tools/dev/__main__.py
triggers:
  topics: [DVC, OSS, 资源还原, 异地部署, 新机, dvc pull, 超时]
  tasks: [异地部署, 新机还原资源, 拉取大文件资源, 还原运行时媒体]
last_governed: 2026-07-15
---

**实测环境与日期**:2026-07-13,本机直连阿里云 OSS(约 ~367KB/s)完整性验证;远端数据本身完好(oss2 全量下载 md5 全对)。

## 钦定路径

```bash
./dev.sh pull              # = git pull + DVC pull(内部走 scripts/sync-dvc-cache.py)
./dev.sh pull --editor     # 同时拉编辑器工程资源
# 等价壳:./scripts/pull-all.sh --editor
```

`sync.pull()`(`tools/dev/__main__.py`)用阿里云官方 `oss2` **同步 SDK** + 多线程(默认 16 worker,分片 16MB,>64MB 走 multipart)+ 断点续传,**无下方那个坑**。DVC 只负责记录版本/校验 hash/本地 checkout,实际上传下载全由 sync 脚本接管。

## 为什么不能用裸 dvc pull / dvc fetch

- 裸 `dvc pull` 在慢速直连下**必挂**:dvc-oss 的异步栈(ossfs/aiooss2)把 `connect_timeout`(60s)当 aiohttp **总超时**用(`aiooss2/api.py`:`self.timeout = connect_timeout or defaults.connect_timeout` → `do_request(req, timeout=self.timeout)`),且**不认环境代理**。
- 后果:>20MB 的对象(动画图集 34~45M、vendor 大包)在慢速直连下一律 `failed to transfer` 空报错(verbose 日志见传输 60.3s 时 `CancelledError`)。远端对象完好,是客户端超时,不是数据坏。
- `dvc_oss/__init__.py` **无任何超时透传旋钮**,没法从配置面救。

## 万一必须修 dvc 原生路径

dvc-oss 无配置面 → 唯一方案是包装进程内 monkeypatch `oss2.defaults.connect_timeout`。但日常一律走上面的钦定路径,不碰原生 dvc pull。

## 相关

工程设施通则(dev.sh 收口、代理 7078、configure-oss)见项目 README「资源结构/日常开发」段。
