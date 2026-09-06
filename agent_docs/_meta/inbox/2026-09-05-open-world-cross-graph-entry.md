现象：dialogue_entry_overrides.py 有意不扫描图内部跳图，json_lang/lint.py 又把 startDialogueGraph.params.entry 误认作本图连边；原生何婆婆话题跳转实机可用但两处误报。
处理：共享入口收集器读取含暂存覆盖的有效对话图；局部连边收集排除外部 entry，外部入口仍按目标图校验，未添加假节点规避检查。
证据：test_dialogue_entry_overrides.py 与 test_dialogue_handoff_lint.py 共 15 条通过，水路校验恢复原 31 个 K.99 错误 / 132 warnings。
