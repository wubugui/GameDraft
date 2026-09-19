---
target: emitted-signal-catalog
date: 2026-09-17
session: 叙事编排全貌面板
---

现象: xref 护栏 `test_every_reference_in_the_real_project_resolves_to_something` / `..._nameable_thing` 在 HEAD 422b066 上就红——`game_config.json#/health/tetherCondition/all/1/any/*` 三条读状态引用没有主体类别（`_SUBJECT_BY_KIND` 无 gameConfig 条目），与本次「编排全貌」改动无关。
证据: `.tools/venv/Scripts/python.exe -m pytest tools/narrative_xref/tests -q -p no:cacheprovider`（改动前后失败集合相同，均为这两条）；数据由夜间生存提交带入。
建议: 给 gameConfig 容器登记主体（"全局配置 · 断绳条件"之类），或把 game_config 的 health 条件面单列一类。
