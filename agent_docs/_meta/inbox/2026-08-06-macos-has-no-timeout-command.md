# macOS 上没有 `timeout`，套管道后退出码还会被吃掉

- **现象**：用 `for f in ...; do out=$(timeout 180 pytest "$f" | tail -2); rc=$?; ...` 扫挂死文件，报告"全部通过"。
- **真因**：macOS 无 `timeout`（GNU coreutils 才有，`gtimeout` 需 brew）→ 每条都 command not found；
  且 `rc=$?` 取的是管道最后一段 `tail` 的退出码，恒 0。**扫描等于什么都没跑，却给出"全绿"的假结论。**
- **对策**：本仓库定位挂死用 `(cmd > log 2>&1 &)` + `sleep` + 看日志尾 + `pgrep` 判活；
  或先 `brew install coreutils` 用 `gtimeout`。
