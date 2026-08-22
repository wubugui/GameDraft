---
target: editor-change-verification-gate
date: 2026-08-19
session: 修 tools/dev/sync.py 的 audio_sources 拉/推不对称（跑收尾门时撞到）
---

# pytest 收尾挂死的根因:cacheprovider 在被写保护的仓库里重试建临时目录

- **现象**：`pytest tools/dev/tests -n0`（**没有 xdist worker**）也会触发
  `tools/conftest.py` 的 120s 收尾守卫强退。加 `-p no:cacheprovider` 后同一条命令
  1 秒跑完、76 passed 干净退出。
- **根因（守卫 dump 的 controller 线程栈直接指出来的）**：
  `cacheprovider.pytest_sessionfinish` → `_make_cachedir` → `tempfile.mkdtemp`
  → `repo_write_guard.__call__/_block/_event_paths` → `Path.resolve()`。
  `.pytest_cache` 在仓库内，写保护拦下建目录，而 `mkdtemp` 会**换个随机名重试到
  TMP_MAX(=10000) 次**，每次都走一遍守卫的 `resolve()`——不是死锁，是万次重试把收尾
  拖成分钟级。
- **与库内认知的冲突**：2026-08-17 那条note把挂死归给「xdist worker 尾巴不退 /
  QtWebEngine 残留」，并等着"下次自然复发时凭 py-spy 栈定罪"。这次复发在
  **`-n0` 且完全不碰 Qt** 的纯 stdlib 测试上，说明至少存在一条与 worker、与 Qt
  都无关的独立路径；卡的是 controller 自己。
- **影响**：任何人跑 `pytest tools/...` 都白等 120s 并拿到被强退的会话，
  真实退出码虽被守卫保真、但摘要行会被冲掉，容易被误读成"测试挂了"。

## 待处置（未做，留给治理 run 定夺）

最小修法看着是让 `.pytest_cache` 落到仓库外（`-p no:cacheprovider`，或 pytest.ini 里
`cache_dir` 指到 tmp），而不是继续加固守卫。**本次未改 pytest.ini** ——那是全仓验收门的
公共配置，超出本次改动（tools/dev 的 DVC 拉取通道）的疆域。
