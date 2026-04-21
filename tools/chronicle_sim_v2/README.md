# ChronicleSim v2

编年史模拟器 v2 — 文件即数据库 + Cline CLI 驱动的多 Agent 叙事沙盒。

## 架构要点

- **零 SQLite**：Run 产物全部落在磁盘（JSON / Markdown），语义检索用 ChromaDB
- **Agent 执行**：每次调用都起一个**独立的 Cline 子进程**，工作区是一次性的临时 cwd
  - `.clinerules/01_role.md` 写入本次 Agent 的 system prompt（由 TOML spec 渲染）
  - `.clinerules/02_mcp.md` 在启用 Chroma MCP 时写入引用约束
  - 探针（probe）会将 `chronicle/` 以只读快照 `copytree` 进 cwd，供 Cline 内置 `read_file` 直接使用
- **TOML 单一来源**：每个 Agent 的 prompt/选项放在 `data/agent_specs/<slot>.toml`，代码只负责占位符渲染，没有散落在 Python 里的 Markdown 字符串
- **MCP 自动注册**：选中或新建 Run 时，`ensure_mcp_for_run(run_dir)` 会把 `chroma_search_world` / `chroma_search_ideas` 以 stdio 方式注册进 `run_dir/.cline_config/data/settings/cline_mcp_settings.json`，无需人工配置
- **LLM 透明化**：每次调用在 `run_dir/.chronicle_sim/llm_effective/` 留下一份脱敏快照（`api_key_mask="***"`，只记录 argv 摘要、计时、spec 选项），审计日志在 `run_dir/llm_audit/`

## 依赖

- **Python 3.12+**：`pip install -r tools\chronicle_sim_v2\requirements.txt`
- **Node.js 20+**：`npm install -g cline`（CLI 文档：https://docs.cline.bot/cline-cli/installation）
- **Cline 凭据**：每次 Agent 任务前，runner 会设置 ``CLINE_DIR=<run_dir>/.cline_config``，并按当前槽位 `ProviderProfile` 非交互跑一次 ``cline auth --config <run_dir>\\.cline_config ...``（与官方 CLI 一致：``--config`` 为 ``clineDir``，凭据落在其下 ``data/``），与界面里填的 `api_key` / `base_url` / `model` 对齐，无需提前手工 `cline auth`

## 启动

```bat
pip install -r tools\chronicle_sim_v2\requirements.txt
python -m tools.chronicle_sim_v2
```

## 命令行周模拟（与 GUI「模拟」同一路径）

模拟逻辑统一在 ``tools.chronicle_sim_v2.core.sim.simulation_pipeline``；GUI 的「运行本周 / 运行范围」在后台线程中调用同一套 ``run_week_async``。LLM 与 Cline 选项**仅**从 ``<run_dir>\config\llm_config.json`` 读取，请先保存界面中的「保存 LLM 配置」。编年史「素材探针」与种子后台生成同样在运行时从该文件读取，不依赖主窗口内存缓存。

```bat
cd /d D:\path\to\GameDraft
set PYTHONPATH=%CD%
python tools\chronicle_sim_v2\scripts\run_simulation_once.py tools\chronicle_sim_v2\runs\<run_id> --week 1
python tools\chronicle_sim_v2\scripts\run_simulation_once.py tools\chronicle_sim_v2\runs\<run_id> --from 1 --to 3
```

或从仓库根目录使用包装脚本 ``run-chronicle-sim-week.cmd``（参数原样传给上述 Python 脚本）。

**Cline 与 OpenAI 兼容网关**：子进程设置 ``CLINE_DIR=<run_dir>/.cline_config``，凭据写入 ``<run_dir>/.cline_config/data/secrets.json``，且 ``cline auth`` / ``cline task`` 的 ``--config`` 同为 ``<run_dir>/.cline_config``（与 Cline 内部 ``join(clineDir, \"data\")`` 布局一致）。若未设置 ``CLINE_DIR``，密钥会落到用户 ``~/.cline/data``，易出现 ``auth`` 与 ``task`` 读的不是同一套凭据、任务回退默认路由等问题。官方 CLI 里 ``cline task -m`` 面向 Cline **内置**模型目录；对自定义 ``base_url`` 的 ``openai_compat``，runner 在 ``task`` 上**不追加** ``-m``，模型由 ``cline auth -p openai -m <modelid> -b <base>`` 与 ``llm_config.json`` 决定。

## llm_config 可选字段

- `cline_executable`：`cline` 可执行文件路径；不填时先查 PATH，再在 Windows 上尝试 `%APPDATA%\npm\cline.cmd`（解决从 IDE/Conda 启动时 PATH 不含 npm 全局目录的问题）
- `cline_timeout_sec`：单次子进程超时（秒），默认 3600，jsonl 输出时放宽到 7200；同时也是 Python 侧 `asyncio.wait_for` 的上限
- `cline_verbose`：为 `true` 时在 `cline` 命令行加入 `--verbose`，让 Cline 在默认抑制控制台时仍输出更详细的进度/推理类日志（具体以 Cline CLI 为准）
- `cline_stream_stderr`：默认 `true`，运行中把 Cline 的 **stderr 按行**转发到种子/模拟日志或 LLM 追踪；设为 `false` 则仅在结束时汇总长度（适合极端刷屏场景）
- `llm_audit.enabled`：是否写 `run_dir/llm_audit/<YYYYMMDD>.jsonl`
- `trace.*`：详细 prompt 追踪开关
- **`rumor_sim`**（可选，对象）：谣言概率传播与变异 LLM 上限，写在 `config/llm_config.json` 顶层。字段示例：
  - `max_llm_calls_per_event`：每条 GM 事件衍生的谣言过程最多调用几次「走样」LLM（默认 32，上限 256）。
  - `max_propagation_rounds`：传播轮次上限（默认 12）。
  - `p_each_spreader_starts`：每个 `spread_agents` 是否作为本轮起点的概率（默认 0.55）。
  - `p_follow_edge`：沿社交图边是否继续传给邻居的概率（默认 0.38）。
  - `skip_distort_llm`（可选，布尔）：为 `true` 时仍按 ``max_llm_calls_per_event`` 与 ``mutation_probability`` 抽样并扣减配额，但**不调用**走样 LLM，内容用占位缩短句（与把 ``max_llm_calls_per_event`` 改成 0 无关，概率模型不变）。
  - 走样抽样概率 ``mutation_probability``：**轮次因子** ``sin(π·round_idx/(max_propagation_rounds+1))``；在 ``round_idx <= max_propagation_rounds//2`` 前 **LLM 预算因子恒为 1**，过半后为 ``remaining_llm / max_llm_calls_per_event`` 再与轮次因子相乘。**不走批量异步 API**，仍为实时逐条调用。

单独校验谣言传播（默认临时最小世界 + stub）::

    python tools\\chronicle_sim_v2\\scripts\\run_rumor_spread_standalone.py
    python tools\\chronicle_sim_v2\\scripts\\run_rumor_spread_standalone.py --run-dir <已有 run 目录>

对已有 Run 的某一周做**统计**（复制 ``world``、**原样**使用 Run 的 ``rumor_sim``；默认 ``run_rumor_spread(..., skip_distort_llm=True)`` 不调走样 LLM）::

    python tools\\chronicle_sim_v2\\scripts\\run_rumor_week_stats.py --run-dir <run 目录> --week 1

若要在统计脚本里真的走 ``_distort_one``（stub 占位或 Cline，取决于 ``pa``）::

    python tools\\chronicle_sim_v2\\scripts\\run_rumor_week_stats.py --run-dir <run 目录> --week 1 --call-distort-llm

只读已落盘的 ``rumors.json``，统计 ``distorted: true`` 条数::

    python tools\\chronicle_sim_v2\\scripts\\run_rumor_week_stats.py --run-dir <run 目录> --week 1 --from-disk-rumors

写入 ``chronicle/week_XXX/rumors.json`` 的每条谣言可含布尔字段 ``distorted``：本条传播是否进入了走样分支（抽样命中且调用了走样逻辑；stub 下为占位文本，真实 Run 下为 Cline）。

**GM 事件与谣言**：GM 须在每条 `records` 中输出 `related_agents`、`spread_agents`（传播人 ⊆ 相关人）、`actor_ids`；`witness_accounts` 仅绑定**相关人**口供。入库前 `normalize_event_for_rumors` 会补全/过滤非法 id，并保证 `spread_agents ⊆ related_agents`。谣言仅从 `spread_agents` 概率选起点，沿图概率走边。

凡是 Run 特有的目录都不需要用户手填：`run_dir/.cline_config/`（Cline ``clineDir``，其下 ``data/`` 含 settings、secrets、任务状态等）、`run_dir/.chronicle_sim/ws/*`（每次调用的临时 cwd，调用结束即删）、`run_dir/.chronicle_sim/llm_effective/`（脱敏快照）都由代码生成与清理。

## 流程

1. **设定库**：录入灵感、导入 MD 文件
2. **种子编辑**：由 `initializer` Agent 从设定库生成初始世界，或直接手填
3. **模拟**：按周推进，S/A/B 类 NPC 分层、Director 拟事件、GM 仲裁、谣言传播、周 / 月总结、文风润色。生成**当周**意图时，会把**上周** ``chronicle/week_{N-1}/rumors.json`` 里与该 NPC（S/A：本人作 teller 或 hearer）或 B/C 群体相关的传闻摘要一并写入 prompt，使下周行动可体现「听过的谣」。
4. **编年史**：浏览、搜索、探针问答；探针答案强制通过「`read_file` + 引用子串」校验，不合格会自动走诊断补救一轮

## 测试

```bat
cd D:\GameDev\GameDraft
python -m pytest tools\chronicle_sim_v2\tests -q
```
