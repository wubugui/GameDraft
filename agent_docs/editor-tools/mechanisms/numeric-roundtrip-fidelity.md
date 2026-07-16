---
id: numeric-roundtrip-fidelity
title: 数值往返保真(preserve_numeric_repr)
domain: editor-tools
type: mechanism
summary: Qt 数值控件会把"打开即保存"变成 int→float 漂移/clamp 丢值/默认 0 盖掉运行时默认——未改动的数值键必须按原始表示回写
status: active
authority:
  - tools/editor/shared/numeric_roundtrip.py#preserve_numeric_repr
  - tools/editor/shared/action_editor.py#_ACTION_PARAM_RUNTIME_DEFAULTS
triggers:
  paths: ["tools/editor/shared/numeric_roundtrip.py", "tools/editor/shared/action_editor.py", "tools/editor/editors/timeline_editor.py", "tools/editor/editors/anim_editor.py"]
  topics: [数值漂移, QDoubleSpinBox, 往返保真, 运行时默认值]
  tasks: [给编辑器加数值控件, 给 action 加数值参数]
verified_by:
  - tools/editor/tests/test_cutscene_roundtrip_fidelity.py
  - tools/editor/tests/test_anim_editor_save_fidelity.py
last_governed: 2026-07-11
---

## 是什么(一句话)

Qt 数值控件天然破坏 JSON 数值表示(QDoubleSpinBox 一律 float、量程会 clamp、缺键被默认值补齐),本机制让"未被用户改动的数值键"按磁盘原始表示回写。

## 权威源(读代码从哪进)

- `tools/editor/shared/numeric_roundtrip.py` 的 `preserve_numeric_repr(out, original)`:在每个 `to_dict` 出口对 params 调一次;需要构造时存 `_original_params` 深拷贝快照(切类型时清空)。
- 占位键剔除:`action_editor.py` 的 `_OMIT_WHEN_ABSENT_AND_DEFAULT`(原本无该键且为中性默认时不写)。

## 硬契约

1. **运行时非零默认的 int 参数必须登记**:`action_editor._ACTION_PARAM_RUNTIME_DEFAULTS`(键 = (action, param),同名参数在不同 action 默认不同)、present 侧 `timeline_editor._PRESENT_PARAM_DEFAULTS`——按运行时默认 seed 控件 + 缺键且仍为默认时不回写。不登记的后果是**行为级** bug:控件默认 0 盖掉运行时 `?? 1000` 类默认,"打开即保存"把不给物品/瞬切写进数据。
2. **坐标控件量程给足世界坐标**:泛型 `±50` 量程会把数千的世界坐标 clamp 成 50——真数据丢失;坐标本应走地图点选。
3. **控件量化(如 QSpinBox 截断 float)会让等值恢复失效**:用种子快照法——载入记原字面值+截断种子,保存时控件仍==种子→写回原字面值;保存成功后用盘面新值重建种子。样板 `anim_editor.py`。
4. **键序**:重建 dict 时原有键回原位置,只有新增键才插固定位置。

## 已知坑

- 真实过场数据曾因 QDoubleSpinBox 一次往返漂移 125 处——"只是打开看了一眼再保存"不是无害操作,保真必须在 to_dict 出口兜住。

## 怎么验证

- `test_cutscene_roundtrip_fidelity.py`(真实工程 + 合成过场类型级 deep-equal、缺键不注入、显式值保留)、`test_anim_editor_save_fidelity.py`(逐键+键序 deep-equal)。
