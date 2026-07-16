# 双运行壳对账协议

本协议只负责观测与差分，不承载游戏内容，也不允许用调试命令代替真实玩法实现。

## 权威与生成

- `src/core/devRuntimeCommands.ts` 的 `RuntimeCommand` 联合类型是命令名称和可接收字段的唯一权威。
- `godot_port/tools/build_runtime_contracts.py` 从该联合类型提取字段，并补录同文件中 `applyDevRuntimeCommand` 的必填、默认、归一化和边界语义。
- `runtime-command-contract.json` 与 `runtime-snapshot-schema.json` 是生成物；源代码与生成物不一致时，检查直接失败。
- Godot 未实现的命令必须返回失败或不登记，禁止空 handler、永真成功和静默跳过。

## P0 控制面

协议版本为 1。一次请求可包含：

1. `ping`：证明目标进程与协议版本可用，返回 `pong`。
2. `captureSnapshot`：使用与 TypeScript 相同的 `captureSnapshot` 命令形状，返回符合快照 Schema 的状态。

这些控制操作只用于建立对账通道；它们不计入任何玩法 capability。

## 使用

```bash
python3 godot_port/tools/build_runtime_contracts.py
python3 godot_port/tools/parity_runner.py godot
python3 godot_port/tools/parity_runner.py run
```

`run` 会启动 Vite 与无头 Chrome、驱动 TypeScript 壳发布快照，同时启动无头 Godot 完成同一请求，随后输出逐字段差异到 `compatibility/parity-last-report.json`。

迁移期间只要求两个快照都通过结构契约，值差异会如实保留。最终验收使用 `--require-equal`；在差异清零前该命令必须失败。
