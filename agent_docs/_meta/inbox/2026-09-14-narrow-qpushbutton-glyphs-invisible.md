---
target: editor-tools-norms
date: 2026-09-14
session: 动作大纲编辑器重写
---

现象: 现用主题下 24px 宽 QPushButton 的字形被内边距整个挤没（ActionEditor 每行 ↑↓− 在真编辑器里一直是三个空色块，连 "X" 都看不见），shared-widget-value-fidelity 卡只提了 30px 窄按钮要走共享出口，没说 QPushButton 本身就不行。
证据: 离屏上主题并排渲染 QPushButton / QToolButton 同文案同 24px 宽，前者空白后者正常；修法 tools/editor/shared/action_editor.py `_glyph_button`（QToolButton）。
建议: 布局纪律里加一句「单字形窄按钮一律 QToolButton」，并做个静态扫描护栏（setFixedWidth(≤30) 的 QPushButton）。
