---
target: timeline-editor-contracts
date: 2026-08-10
session: cutscene 校验只报条数不报问题
---

现象: 卡里「校验结果落行标记」被当成已有能力，实际逐行通道用 scan_param_refs=False，
参数引用类问题（真实工程里唯一在报的一类，赌坊输钱 6 条）一行都落不上，只在状态区出条数、
正文仅存在于 tooltip = 用户眼中「报了问题但看不见问题」。
证据: 修前 `_run_current_cutscene_validation` 逐行只跑结构校验；修后逐行补
`_walk_cutscene_action_param_refs`（判据用整树 temp_actor_ids、扫描面限本行）+ 新增可见问题清单
（`TimelineEditor._issue_list`，点条跳步）+ validator 消息步号改层级号（step #4 / step #4.2，
新增 step_label_prefix/step_index_base 两个缺省即历史行为的键参）；
护栏 tools/editor/tests/test_cutscene_validation_report.py（8 用例，从 `_btn_validate` 真入口进）。
建议: 卡里「已有能力」条目补一句「问题清单（可见、可点跳）+ 逐行归因含参数引用」，
免得下一轮又当没有去重造或又以为标记已覆盖全部问题类型。

追记（同日）: 浮点等值断言的坑——`test_scene_group_canvas_move.py` 曾在整套跑时红 4 条
（单跑必绿），根因是拖动 Δ 由视口像素经视图变换换算（96.1），各成员基准量级不同，
`(160+96.1)-160=96.10000000000002` 而 `(100+96.1)-100=96.1`，assertEqual 等于在赌
Δ 二进制可精确表示；前面跑过 test_all_editors_construct 会改变画布缩放就翻车。
已改成按容差比（`_assert_points_close`）。凡"用户手势→坐标"的断言一律别用 assertEqual。
