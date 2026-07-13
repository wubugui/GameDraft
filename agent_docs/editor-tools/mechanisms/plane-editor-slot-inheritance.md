---
id: plane-editor-slot-inheritance
title: 位面编辑器槽继承 UI 语义
domain: editor-tools
type: mechanism
summary: dict 槽用"显式配置此槽"闸门——不勾=不写键(继承)、勾且空 {} 是合法的整槽覆盖原语;解析口径与运行时 expandExtends 靠 parity 测试锁定
status: active
authority:
  - tools/editor/editors/plane_editor.py#resolve_effective_slots
  - src/systems/PlaneReconciler.ts
triggers:
  paths: ["tools/editor/editors/plane_editor.py", "public/assets/data/planes.json"]
  topics: [位面, plane, extends, 槽继承]
  tasks: [改位面编辑器, 加位面槽字段]
verified_by:
  - tools/editor/tests/test_plane_editor_inheritance.py
last_governed: 2026-07-11
---

## 是什么(一句话)

位面 extends 链上"键缺席=继承父、键存在=覆盖"的运行时语义,在编辑器里必须用显式闸门表达,否则 UI 无法区分"没配置"与"配置为空"。

## 权威源(读代码从哪进)

- 编辑器解析:`tools/editor/editors/plane_editor.py` 的 `resolve_effective_slots` + `INHERITED_SLOT_KEYS`
- 运行时口径:`src/systems/PlaneReconciler.ts` 的 expandExtends(位面系统整体见 runtime 域位面机制卡)

## 硬契约

1. dict 槽(movement/interaction/travel 类)用「本位面显式配置此槽」闸门:不勾 = 不写键(继承),控件灰显沿 extends 链解析的生效值;勾 = 写槽。
2. **空 `{}` 是合法的"用缺省整槽覆盖父配置"原语**——保存路径不得 pop/丢弃显式空槽(修过的真 bug)。
3. 标量/枚举槽同理:membership 用三态下拉(继承/显式值);数值槽用「显式写入」勾选——**写 0 也是显式值**,不能拿 falsy 判"未配置"。
4. `resolve_effective_slots` 与运行时 `expandExtends` 必须同口径;`INHERITED_SLOT_KEYS` 两侧 parity 测试锁定,加槽两边一起加。
5. extends 缺父/成环在 save_all 的 presave 段拦截(与 validator 共享 `plane_extends_errors`)。

## 已知坑

- 任何"顺手把空 dict 清理掉"的规范化都会破坏语义 2——继承语义下,键的有无本身就是数据。

## 怎么验证

`tools/editor/tests/test_plane_editor_inheritance.py`(含 INHERITED_SLOT_KEYS parity);改后跑黄金往返。
