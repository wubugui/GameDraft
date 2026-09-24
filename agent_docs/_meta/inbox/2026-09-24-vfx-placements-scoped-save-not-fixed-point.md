---
target: vfx-workbench
date: 2026-09-24
---

现象: 卡上写「唯一写入者 + 往返零改字节」,但 placements.save_changes 原地赋值合并:给只有 variants 的场景加 base 落成 variants 在前、清空一份留 `"base": []` 空壳——真库 09-21 起不是 normalize 不动点(崖墓入口),另 4 条编辑器测试写死真库 id、selftest S18 写死「2 个按钮」,库一长就挂。
证据: save_changes 已改走 vp.set_rows(set_rows 收场景键序),回归 test_scope_save_writes_a_normalize_fixed_point;`--check` 仍报「盘上字节不是归一化形」直到制作人同意重排 vfx_placements.json。
建议: 卡的硬契约补一句「scoped 合并也必须落成闸门不动点」;真数据用例一律从库现算期望,不写死 id / 外观数。
