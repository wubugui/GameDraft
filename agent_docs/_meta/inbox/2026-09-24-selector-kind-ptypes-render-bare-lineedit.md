---
target: editor-tools-norms
date: 2026-09-24
session: 呼吸图动作编辑器登记
---

现象: 选择器铁律说引用/枚举字段禁裸 QLineEdit，但 `_PARAM_SCHEMAS` 里写成选择器 kind 的 ptype（playCanvasVfx.effect=`vfx_effect`、showCanvasEntity/setCanvasEntityTransform.facing=`facing_lr`、setCanvasOrder.kind=`canvas_item_kind`，连同 showCanvasEntity.character/animFile）在泛型构造循环里没有分派，实测全是裸 QLineEdit；另 setPropState.fadeMs / fadeLight.fadeMs 的专用 elif 排在泛型 `ptype == "int"` 之后，是死分支（量程与 tooltip 从未生效）。
证据: 离屏 `ActionRow({"type": "playCanvasVfx", "params": {}}, model=None)._param_widgets` → effect/name 均为 QLineEdit；action_editor.py 泛型循环 `elif ptype == "int"` 先于 `act_type == "setPropState" and pname == "fadeMs"`。CONTENT_ID_PARAMS 未收 playCanvasVfx.effect，故宇宙级 parity 测试也抓不到。
建议: 泛型循环加「ptype ∈ _SELECTOR_KIND_UNIVERSE 或已知枚举 kind → _make_selector(ptype)」分派，并把 playCanvasVfx.effect 补进 CONTENT_ID_PARAMS；死分支挪进 int 分支内部。
