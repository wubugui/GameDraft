位置：meta/recipes/dvc-oss-restore.md 的“按本机DVC缓存过滤”与 tools/dev/sync.py::target_is_in_local_cache。
偏差：worktree 的 cache.dir 指向 D:/GameDraft/.dvc/cache 时，该函数仍只查 worktree/.dvc/cache，误报五个已有目标缺缓存并跳过上传。
实证：本轮指定 sync-dvc-cache.py --root D:/GameDraft 并传迁移树五个绝对DVC指针后上传4对象，复核5136对象、0上传；应按DVC配置解析缓存路径，本轮仅记录未改工具。
