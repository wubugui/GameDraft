---
target: narrative-state-editor
date: 2026-08-07
session: 信号关系（谁发谁听）
---

现象: 信号选择弹窗的注释写着"发射源跨对话/场景/运行时，无法在此可靠统计"，因此只显示监听数；
现在宿主侧有共享扫描 slot（`scanSignalXref`，只读、含画布草稿），发射侧可靠统计已经成立。
证据: `tools/narrative_editor_web/src/components/SignalPickerModal.tsx:146` 的注释 vs
`tools/editor/editors/narrative_state_editor.py::scanSignalXref` + 面板 `SignalXrefPanel.tsx`。
建议: 弹窗仍不改（它是选择器，不该为一次选择去扫全工程）；卡里补一句"要看两侧去信号关系面板"，
并记下弹窗那行注释已过期的原因，免得后人照它下结论说"发射数统计不了"。
