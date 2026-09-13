---
target: missing
date: 2026-09-12
session: 编辑器野窗口/卡顿排查
---

现象: 工作树里 `主线_铜钱脱落滚走__part1.steps[3].tracks[1].scale = 1.8000000000000003`，编辑器往返会把它规范成 1.8，`test_cutscene_roundtrip_fidelity::test_real_cutscenes_type_level_roundtrip` 因此红；HEAD 里没有这个值(未提交的编辑写进去的)。
证据: `grep -n 1.8000000000000003 public/assets/data/cutscenes/index.json` 命中一处；同一测试在 HEAD 工作树上绿。
建议: 谁写出这个 1.8000000000000003 就在哪儿补 round(见 numeric-roundtrip-fidelity)；这次不是本次改动引入的，先记账。
