---
target: save-all-dirty-buckets
date: 2026-08-17
session: clues.json 线索注册表接入编辑器（Clues 页 + [clue:] 插入选择器）
---

现象: 卡片说新数据域"三处同步"(登记+save_all 分支+mark_dirty 调用点),实际接 clues 桶要动五处——还有 `_planned_write_paths`(外部改动检测/基线,与 save_all if 链同步维护)与 `lsp_client._SIMPLE_OVERLAY_FILES`(overlay 镜像,json-lang 卡有提但本卡没交叉引用)。
证据: tools/editor/project_model.py(_planned_write_paths 的 "clues" 分支)、tools/editor/shared/lsp_client.py:273 附近;漏 overlay 时 test_lsp_overlay_parity 抓获(本次实际踩到)。
建议: 卡片"三处同步"改为列全五处或在硬契约里交叉引用 _planned_write_paths 与 overlay parity。
