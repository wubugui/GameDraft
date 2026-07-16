# ChronicleSim v2

编年史模拟器 v2：文件即数据库 + Cline CLI 驱动的多 Agent 叙事沙盒。

## 依赖

- 项目本地 Python：`.tools/venv/bin/python`
- Node.js 20+：`npm install -g cline`
- Cline 凭据：runner 会设置 `CLINE_DIR=<run_dir>/.cline_config`，并按当前
  `ProviderProfile` 非交互跑 `cline auth --config <run_dir>/.cline_config ...`

## 启动

```bash
./dev.sh install-deps
./dev.sh chronicle-sim-v2
```

## 命令行周模拟

模拟逻辑统一在 `tools.chronicle_sim_v2.core.sim.simulation_pipeline`。GUI 的
“运行本周 / 运行范围”在后台线程中调用同一套 `run_week_async`。

```bash
PYTHONPATH="$PWD" .tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_simulation_once.py tools/chronicle_sim_v2/runs/<run_id> --week 1
PYTHONPATH="$PWD" .tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_simulation_once.py tools/chronicle_sim_v2/runs/<run_id> --from 1 --to 3
```

也可以使用：

```bash
./dev.sh chronicle-week tools/chronicle_sim_v2/runs/<run_id> --week 1
```

## llm_config 可选字段

- `cline_executable`：`cline` 可执行文件路径；不填时查 PATH。
- `cline_timeout_sec`：单次子进程超时（秒），默认 3600，jsonl 输出时放宽到
  7200。
- `cline_verbose`：为 `true` 时在 `cline` 命令行加入 `--verbose`。
- `cline_stream_stderr`：默认 `true`，运行中把 Cline 的 stderr 按行转发到日志。

单独校验谣言传播：

```bash
.tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_rumor_spread_standalone.py
.tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_rumor_spread_standalone.py --run-dir <已有 run 目录>
```

对已有 Run 的某一周做统计：

```bash
.tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_rumor_week_stats.py --run-dir <run 目录> --week 1
.tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_rumor_week_stats.py --run-dir <run 目录> --week 1 --call-distort-llm
.tools/venv/bin/python tools/chronicle_sim_v2/scripts/run_rumor_week_stats.py --run-dir <run 目录> --week 1 --from-disk-rumors
```

## 测试

```bash
.tools/venv/bin/python -m pytest tools/chronicle_sim_v2/tests -q
```
