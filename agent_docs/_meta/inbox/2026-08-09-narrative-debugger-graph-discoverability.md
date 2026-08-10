---
target: editor-tools
date: 2026-08-09
session: 叙事调试器「好多状态图看不到」
---

现象: 策划反馈调试器"看不全所有状态图，赌场交互点那张根本搜不到"。数据里图是全的
（`街巷_赌坊` / 赌场交互点，挂 npc `街巷_赌坊门卫`，在 `composition_3`），是三处界面口径把它藏了：
① 左栏一次只列一条线，搜索框只筛已填进列表的行 → 在主线搜「赌场」必然 0 条；
② 线下拉框的名字取 `comp.label or comp.id`，编辑器新建的线不写 label → 摆出一串 `composition_3`；
③「按场景看」只按"这个场景能打出哪些信号"反查监听方 → 门卫那张图听的信号是别处发的（还有
`__draft__` 占位），人站在雾津街头也列不出来。
证据: `NarrativeIndex` 单独加载真实数据 56 张图全在、`graph_owners['街巷_赌坊'].scene == '雾津街头'`；
下拉框与 `_apply_beat_filter` 的代码路径见修复前 `main_window.py`。
建议: 已修（搜索改全工程、命中在别处就接在列表末尾且可点跳转；下拉框按"文件里有几条线"建、
无 label 退到主图名；`scene_graphs` 并上 owner 在本场景的 wrapper 图；xref 引擎同款线名回退口径）。
沉淀点: **"一次只列一个切面"的清单，搜索必须能越过那个切面**——否则空结果读起来跟"这东西不存在"
一模一样，而工具的全部价值就是回答"我做过的那东西在哪"。护栏在
`tools/narrative_debugger/tests/test_debugger_ui.py`（别处命中/可跳转/不堆积/截断明说/下拉框全覆盖）
与 `test_narrative_debugger.py::test_scene_view_lists_graphs_owned_by_someone_standing_there`。
