# 编年史模拟器（ChronicleSim）

独立 PySide6 工具：周循环、Tier S/A NPC agent、`ChronicleDirector`事件采样、`GMAgent` 裁决、`RumorAgent` 社交扩散、周/月总结与导出。

## 运行

在项目根目录（`GameDraft/`）：

```bat
pip install -r tools\chronicle_sim\requirements.txt
start-chronicle-sim.cmd
```

或：`python -m tools.chronicle_sim`

## 使用 LM Studio（本机 OpenAI 兼容）

1. 在 LM Studio 中加载模型并**开启 Local Server**（默认一般为 `http://127.0.0.1:1234`，具体以界面为准）。
2. 在 ChronicleSim「LLM」子页，将需要走本机模型的档位（如 `default`、`gm`、`director`、各 Tier NPC 等）设为 **OpenAI 兼容 API**：
   - **API Base URL**：填 LM Studio 给出的 **v1 根地址**，通常为 `http://127.0.0.1:1234/v1`（末尾 **`/v1` 不要漏**）。
   - **模型名**：与 LM Studio 里当前服务使用的 **模型标识**一致（可在 LM Studio 的模型/服务器界面查看）。
   - **API Key**：多数本机服务可留空；若 LM Studio 要求随机字符串，按其设置填写即可。
3. **嵌入**：若用 LM Studio 提供 embedding 接口，同样在表单顶部「嵌入」区选 OpenAI 兼容，`base_url` 与对话相同，`model` 改为嵌入模型名；否则可关闭嵌入，由 NPC 配置推导（见表单说明）。
4. 填好后点「保存 LLM 到 run」；长上下文或慢模型可在「代理」页适当调高 **HTTP 读超时**。

## 典型流程

1. **配置控制台**：新建 run →「插入演示 NPC」或「从蓝图生成种子」并应用 → 在 Tier 表调整 `current_tier` 并保存。
2. **LLM**：默认 `stub` 无需联网；若接 API，在「LLM」子页写 JSON（如 `tier_s_npc`/`gm`/`director` 的 `kind`/`base_url`/`api_key`/`model`）。
3. **运行**：指定周次 →「运行该周」；或使用「推进周次」+「批量结束周」→「运行周次范围」逐周执行。推进时主窗口会暂时关闭各 Tab 持有的 `run.db` 连接，仅后台编排器独占写入；失败或取消时会尝试用周开始前复制的 `._week_N_rollback.bak` 覆盖回 `run.db`。
4. **回滚**：「回滚」子页用某周 `snapshots/week_XXX.db` 覆盖 `run.db`（会先关闭当前连接）。若周运行中断且自动恢复失败，可手动用快照或备份文件恢复。
5. **LLM 审计**：在「LLM」页勾选「启用审计日志」并保存后，非 Stub 请求会在 `runs/<id>/llm_audit/` 下按日追加 JSONL（已脱敏/截断）。HTTP 重试次数与退避在「代理」页配置，写入 `llm_config_json.http`。
6. **Chroma / 向量**：关闭应用时会释放嵌入客户端；若进程被强杀，可能残留锁文件，需自行结束占用或删缓存后重试。嵌入维度与库内已有向量不一致时会报错（`EmbeddingSchemaError`），不会静默覆盖。
7. **编年史浏览器 / 探针 / 导出 / Agent Inspector**：按需查看与导出；导出页可「分支复制」生成新 run 目录。Inspector 超大日志仅加载前约 1.5MB，避免界面卡死。

## 数据与提示词

- `tools/chronicle_sim/data/event_types.yaml`：事件类型库
- `tools/chronicle_sim/data/pacing_profiles.yaml`：pacing 曲线
- `tools/chronicle_sim/data/prompts/*.md`：各 agent 提示词

## 首轮验收（作者手动）

按策划文档规模跑一次长模拟，检查：志怪比例、川渝腔、探针区分度、Tier 与隔离、回滚与分支。基础回归可运行：`python -m pytest tools/chronicle_sim/tests/test_chronicle_fixes.py`（自项目根目录 `GameDraft/`）。
