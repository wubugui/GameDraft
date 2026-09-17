---
target: held-prop-lights
date: 2026-09-15
session: 挂件灯物理闪烁的编辑器/校验器接入
---

现象: 挂件灯的表单（含闪烁两种写法的「种类」下拉）住在 `tools/editor/editors/prop_preset_blocks.py`，校验在 `tools/editor/validator.py::_prop_light_issues`，但 `audit.py --paths` 对这两个文件不列 held-prop-lights 卡（triggers.paths 只登记了 prop_preset_editor.py）。
证据: `sh scripts/py.sh agent_docs/_meta/audit.py --paths tools/editor/editors/prop_preset_blocks.py` 只出 editor-tools 通用卡；闪烁契约全文在 held-prop-lights。
建议: triggers.paths 补 `tools/editor/editors/prop_preset_blocks.py`；卡里「怎么验证」可指向 `tools/editor/tests/test_prop_flicker_forms.py`（两种写法的校验 / 往返 / 切种类）。
