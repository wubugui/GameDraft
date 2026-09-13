---
target: shared-widget-value-fidelity
date: 2026-09-12
session: action_editor 最小形态往返收口（8 个凭空长键的 action）
---

# playVfx / emitVfxField 的位置引用 `at` 是裸 QLineEdit —— 卡里列的宿主清单漏了这两个

- 现象：卡里说 `PositionRefField` 是位置引用 `at` 的统一复合控件，宿主是「六条位置动作 +
  playTrajectory + cameraMove（+ cameraFollowActor / faceEntity 走老键映射）」。但 `playVfx`
  与 `emitVfxField` 的 `at` **不在这个清单里**：它们没有专用 `_rebuild_*` 表单，`at` 落进
  `_PARAM_SCHEMAS` 泛型循环，`ptype == "position_ref"` 匹配不到任何分支，掉到末尾的
  `else: w = QLineEdit(str(val))` —— 正是本域 norms 第一条铁律（引用字段禁裸 QLineEdit）
  要挡的形状。同一个动作的另外两个引用参数（`instanceId` / `effect`）倒是规规矩矩走了选择器，
  `test_vfx_action_registration.py::test_selector_kinds_map_to_real_universes` 还在锁着。
- 证据：`tools/editor/shared/action_editor.py` 的 `_PARAM_SCHEMAS["playVfx"/"emitVfxField"]`
  有 `("at", "position_ref")`，但 `_to_dict_raw` 的专用 to_dict 派发表里没有这两个。
  后果实测（2026-09-12）：`public/assets/scenes/崖墓.json` 里那条 `emitVfxField`（`at` 是
  `{kind:'entity', id:…}` 的 dict）打开→不改→保存，会被存成 **Python repr 字符串**
  `"{'kind': 'entity', 'id': 'player'}"` —— 运行时 `parsePositionRef` 拿它当实体 id 解析不出来
  → `resolveVfxAt` warn 后整个动作静默跳过（那阵风就这么没了）。
- 建议：卡里宿主清单补上"还有两条动作的 `at` 仍在泛型面 / 裸输入框"这一条现状（别让人误以为
  全项目 `at` 都已收进 PositionRefField）。本次只堵了数据安全那一半：`to_dict` 的
  `position_ref` 分支在"文本 == str(原值)"时按磁盘原值回写（回归锁
  `test_action_condition_data_safety.py::test_vfx_dict_position_ref_not_stringified`），
  空串交给 `_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT` 剔除。**真正的修法**是给这两条动作
  接上 `PositionRefField`（同 cameraFollowActor 那套：位置一行搞定，x/y/h 不再各占一行泛型
  数字框），那是改授权面，需要制作人点头 + 同步 `docs/editor-authoring-surface.md`。
