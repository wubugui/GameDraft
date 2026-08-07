---
target: editor-data-sync-paradigm
date: 2026-08-07
session: 场景分组画布代理框 + 整组位移
---

现象: 新增的**批量**写入（整组位移一次改 N 个实体）直写模型 dict 就会丢数据：只要用户拖组之前点过组里任何一个实体，面板就持有它的 source/staging，release 时 `_mark_canvas_edit()` 点亮 pending → commit-on-leave 用**按下之前**的 staging 深拷贝把那个成员整份拍回旧坐标，画布却照新位置画，肉眼看不出来。而且只写 staging 也不够——`_commit_pending_scene_edits` 会先 `flush_pending_to_model()`（widgets→staging），控件里的旧坐标会把刚写的位移**反向覆盖**。
证据: `test_preselected_{npc,hotspot,zone}_still_moves_with_group` 三条，修前全红（该成员 Δ=0、其余成员 Δ=正常）；单实体拖拽从来没中招，因为它走 `_staging_*_for_canvas_drag` + `sync_*_xy_widgets` 两件套。
建议: 卡里补一条「批量写入的三件套」：①按身份解析写入目标（staging 在就写 staging）②同步对应控件（数值框/顶点表/巡逻表）③别只测单实体路径——护栏必须包含"先选中组内成员再做批量操作"。
