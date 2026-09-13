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
  - tools/editor/tests/test_action_condition_data_safety.py
last_governed: 2026-08-05
---

## 是什么(一句话)

Qt 数值控件天然破坏 JSON 数值表示(QDoubleSpinBox 一律 float、量程会 clamp、缺键被默认值补齐),本机制让"未被用户改动的数值键"按磁盘原始表示回写。

## 权威源(读代码从哪进)

- `tools/editor/shared/numeric_roundtrip.py` 的 `preserve_numeric_repr(out, original)`:在每个 `to_dict` 出口对 params 调一次;需要构造时存原始参数深拷贝快照(切类型时清空)。
- 占位键剔除:`action_editor.py` 的 `_OMIT_WHEN_ABSENT_AND_DEFAULT`(原本无该键且为中性默认时不写)。

## 硬契约

1. **运行时非零默认的 int / float 参数必须登记**(action 侧 `_ACTION_PARAM_RUNTIME_DEFAULTS`、present 侧 timeline 的对应表;键 = (类型, 参数),同名参数在不同宿主默认不同):按运行时默认 seed 控件 + 缺键且仍为默认时不回写。不登记的后果是**行为级** bug——控件默认 0 盖掉运行时的非零默认,"打开即保存"把不给物品/瞬切写进数据。
   泛型 int 与泛型 float 两条控件分支都吃这张表,但**泛型 float 那条 2026-09-12 才接上**:此前它硬编码 `setValue(0.0)`,登记了也只是摆着(控件照样显示 0、照样回写 0)——`setEntityShadow` 的 darkness/azimuth、`playVfx.countScale`、`emitVfxField.strength` 就是这么漏出去的。给 float 参数登记完记得确认它没被上面的按 action 特判分支(attachToSocket 支点、playNpcAnimation.speed)抢走。
2. **坐标控件量程给足世界坐标**:泛型小量程会把数千的世界坐标 clamp 成量程上限,真数据丢失;坐标本应走地图点选。
3. **控件量化(如 QSpinBox 截断 float)会让等值恢复失效**:用种子快照法——载入记原字面值 + 截断种子,保存时控件仍==种子则写回原字面值;保存成功后用盘面新值重建种子。样板 `anim_editor.py`。
4. **键序**:重建 dict 时原有键回原位置,只有新增键才插固定位置。

## 已知坑

- 真实过场数据曾因 QDoubleSpinBox 一次往返漂移 125 处——"只是打开看了一眼再保存"不是无害操作,保真必须在 to_dict 出口兜住。

## 怎么验证

`test_cutscene_roundtrip_fidelity.py`(真实工程 + 合成过场类型级 deep-equal、缺键不注入、显式值保留)、`test_anim_editor_save_fidelity.py`(逐键 + 键序 deep-equal)、`test_action_condition_data_safety.py` 的 `test_<action>_minimal_form_does_not_grow_*` 一族(每条 action 的「manifest 最小形态打开→不改→保存」)。

全量复扫(加完 action / 改完控件跑一次,凭空长键就非零退出):

```sh
sh scripts/py.sh -m tools.editor.tests.scan_action_minimal_roundtrip
```
