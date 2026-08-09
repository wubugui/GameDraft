---
target: editor-change-verification-gate
date: 2026-08-09
session: 私有信号 PyQt 侧补齐
---

现象: 配方按 macOS 写的三件套，在 Windows 上 `test_narrative_templates.py::test_save_all_template_roundtrip_byte_identical` **恒红**且与改动无关——`Path.write_text` 默认换行转换把种子文件写成 CRLF，save_all 写回 LF，哈希必然不等（双树对照确认 HEAD 与工作树同红）。
证据: `python -c "...p.write_text(seed)..."` 后 `read_bytes()` 前 120 字节为 `{\r\n  "schemaVersion"`，save_all 后为 `{\n  "schemaVersion"`；`_json_text(normalize_templates_file(...)) == 原文` 在同一份数据上是 IDENTICAL。
建议: 配方加一条平台注记（Windows 下这条计入既有红、判据仍是双树失败集合一致）；根治是测试改 `write_bytes` / `newline=""`。
