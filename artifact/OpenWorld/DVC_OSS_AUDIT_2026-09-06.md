# DVC / OSS 换机同步复核

本次复核对象为 `codex/living-open-world` 分支的全部 4 份 DVC 清单。用户要求同步检查不要下载 OSS 资源正文，避免流量费用。**后续核查只用本地哈希和远端 HEAD 元数据。**

## 本地复核与修正

本地逐文件读取了 3816 份受管资源，并对旧清单的全部 3585 个去重缓存对象（含 4 份目录清单）重算 MD5。无资源缺失、无缓存损坏、无未忽略的新增文件。`.DS_Store` 和生产工作台日志按 `.dvcignore` 排除。

发现编辑器目录有两份自动会话文件更新，没有独有工程源遗漏：

- `editor_data/production_workbench/runtime_debug_snapshot.json`：最后采集现场更新。
- `editor_data/runtime_lighting.json`：时段、时间戳、序号、会话标识更新；`lighting`、`sceneId` 和 `selectedId` 均未变化。

为保存当前工作区，已执行限定目标的 `dvc add resources/editor_projects`，补传上述两个文件与新目录清单：**3 个对象，共 229160 字节**。没有改写资源内容。新清单和两个新缓存对象已在本地再次重算 MD5，与工作区一致。最终 `dvc status --json` 为 `{}`。

| 目标 | 文件数 | 总字节 | 最终目录清单 MD5 |
| --- | ---: | ---: | --- |
| runtime | 2707 | 3175111241 | `8944eae1191e913e92a9e280621313d8.dir` |
| editor_projects | 1087 | 586651704 | `1bce47090bb33497aadb5128c3bc8e0f.dir` |
| audio_sources | 18 | 70564819 | `7aeef641f1379c9172a935ac2176d728.dir` |
| vendor_archives | 4 | 770018942 | `0216b5ffb69cf253552e978ddf71ecee.dir` |

运行时、音源和第三方归档指针未变化。编辑器清单原指针为 `0f6594fd9972c8277ff9d87e23f971c5.dir`；与新清单相比，零新增、零删除，只有上述两处变更。

## OSS 核对范围

仓库 `.dvc/config` 与正式同步脚本使用同一目的地：bucket `gamedraft-assets`，endpoint `https://oss-cn-shanghai.aliyuncs.com`，对象前缀 `gamedraft/dvc/files/md5`。

最终检查从**本地缓存**展开目录清单，仅对引用到的对象调用 HEAD，核对存在性及 Content-Length。ETag 留作证据，不假定分片上传 ETag 等于文件 MD5，也不把元数据一致说成远端逐字节哈希验收。逐对象结果见 `dvc-oss-metadata-audit-2026-09-06.json`。

**最终结果：3585 / 3585 个去重对象存在且大小一致，0 项异常；覆盖全部 3816 份受管文件与 4 份目录清单，耗时 10.523 秒。该轮 HEAD 检查对象正文传输为 0 字节。** 审计发生于本次提交之前，所以报告中的 `pending_pointer_commit` 列出编辑器指针；该指针和本报告一起提交，不能把这个审计时点字段解读为最终遗漏。

## 已中止的错误检查方式

最初错误启动了远端全量 GET 哈希核验，用户指出流量成本后立即停止，已确认进程退出。日志记录 **794 个完整返回对象、343640646 字节（约 344 MB）**；该数不含中断时未完成请求的传输，**不是准确账单流量**。这次 GET 审计没有完成，不能据此声称全量远端内容校验通过。

原下载脚本已替换为只做 HEAD 的元数据审计，禁止下一位代理据旧日志重跑全量下载。实际新机按需还原资源仍使用项目既有 `tools.dev pull` 流程；本约束针对同步核查。

## 可复查证据

- `handoff-dvc-local-audit.json` / `.txt`：修正前完整本地哈希审计，记录两个已解决的快照差异；原始 FAIL 是修正前状态。
- `dvc-editor-refresh-2026-09-06.json`：新旧编辑器清单差异。
- `dvc-editor-upload-2026-09-06.txt`：三对象上传结果。
- `dvc-status-before-deep-audit.json` / `dvc-status-after-deep-audit.json`：修正前后 DVC 状态。
- `dvc-oss-metadata-audit-2026-09-06.json` / `.txt`：最终远端元数据检查。
- `dvc-oss-interruption-2026-09-06.json`、`dvc-oss-audit-2026-09-06.log.txt` / `.objects.jsonl`：误用 GET 的中止记录，保留事实，不作为全量验收。

只重跑元数据检查：

```powershell
.tools/venv/Scripts/python.exe artifact/OpenWorld/dvc-oss-audit.py
```

该复核只涉及交接与资源清单，不改变开放世界进度和玩法验收结论。
