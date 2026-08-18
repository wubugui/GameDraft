---
target: editor-change-verification-gate
date: 2026-08-17
session: 物件自身用途 ItemDef.use 落地
---

现象: 验证门配方说"合成 fixture 能覆盖真实数据没有的形状"，但对**含 ActionEditor 的表单**这条走不通——ActionEditor 会把 `_PARAM_SCHEMAS` 里未填的参数 materialize 成空串，于是手写的 action fixture 打开→不动→Apply 就多出 `"type": ""` 这类键，字节级往返必红；真实数据不红只是因为它本来就是编辑器写出来的。
证据: `tools/editor/tests/test_item_use_and_tags.py::test_open_then_apply_changes_nothing` 用 `showNotification`（schema 两参、fixture 只给 `text`）时 diff 出 `"type": ""`；换成单参数的 `playSfx` 即通过。`_PARAM_SCHEMAS['showNotification'] == [('text','str'),('type','str')]`。
建议: 在验证门配方的"已知盲区"一节补一句：合成 action fixture 必须先按 `_PARAM_SCHEMAS` 补全参数，或改用单参数动作，否则测的是 ActionEditor 的归一化而不是被测编辑器的往返。另可评估让 ActionEditor 对空串可选参数不写键（影响约 40 处调用点，需单独立项）。
