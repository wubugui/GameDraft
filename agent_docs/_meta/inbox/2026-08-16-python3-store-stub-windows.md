# 2026-08-16 python3 在 Windows 机上是 Store stub,直调全线静默空转

- 现象:`python3` 直调 exit 49 零输出 → paths_reminder hook / cli.py / govern.py 在 Windows 侧全部静默失效(治理产物停在 7-25 的 Mac 侧状态,无人察觉)。
- 处理:新增 `scripts/py.sh`(venv 优先→python3→python,失败必出声);cli.py 的 HOOK_COMMAND/闸门块/薄壳模板、CLAUDE.md §G、paths_reminder 提示文本已全部改走 py.sh 并经 install 自愈;另新增 Stop 收尾验证门 `scripts/agent_hooks/validation_gate.py`(廉价判定,门规则对齐 validator.md)。
- 待跟进:库内其余文档(norms/机制卡/README)凡教 agent 直跑 `python3 ...` 的入口未全量清查,建议下次治理 run 统一对账换成 py.sh。
