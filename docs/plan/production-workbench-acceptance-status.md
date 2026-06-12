# 生产工作台交付验收状态

日期：2026-05-31

## 结论

当前状态可以进入策划验收。后续不要继续优先修零碎体验细节，除非每日检查出现 `error` / `blocker`，或策划按指南走不通主流程。

## 最近门禁

最后核对时间：2026-05-31

已通过：

- `.tools/venv/bin/python -m unittest discover tools/editor/tests -p "test_production_workbench*.py"`：118 tests OK
- 生产工作台真实每日检查：`每日检查: 通过`
- 当前计数：`error=0, blocker=0, warning=12`

每日检查通过项：

- `Python 编辑器/Narrative smoke`
- `生产工作台 smoke`
- `Python import smoke`
- `TS Narrative/runtime save smoke tests`

## 验收入口

1. 运行：

```sh
npm run planner:gui
```

## 策划验收路径

1. 打开 `每日检查`，点击 `运行每日检查`。
2. 确认结果是 `每日检查: 通过`。
3. 确认通过项包含：
   - `Python 编辑器/Narrative smoke`
   - `生产工作台 smoke`
   - `Python import smoke`
   - `TS Narrative/runtime save smoke tests`
4. 进入 `剧情单元`，选择一个单元，确认能查看摘要、操作向导、自检和复制报告。
5. 进入 `Graph诊断`，点击刷新，确认能复制诊断报告。
6. 进入 `运行时Debug`，确认能刷新快照、查看命令队列、复制事故报告。
7. 进入素材相关页签，确认能完成素材审计、素材任务文本生成、候选查看、图片工具和动画 Sheet 基础处理。

## 当前非阻塞项

每日检查当前仍有 warning，但没有 error / blocker。已知 warning 属于内容或素材数据待处理，不阻塞工具验收：

- draft narrative signal
- 部分剧情单元缺入口、出口、验收
- 部分图片扩展名与实际格式不一致

这些 warning 应作为内容制作待办处理，不再作为生产工作台继续加功能的理由。

## 收敛规则

- 每日检查 `error=0` 且 `blocker=0`：允许继续内容生产。
- 策划能按《策划 Graph 内容操作指南》完成检查、追踪、诊断、Debug、素材任务和复制报告：认为工具主入口可用。
- 只修会阻断上述流程的问题；不再为了按钮文案、细小布局或锦上添花功能继续扩展。
