---
id: shared-widget-value-fidelity
title: 共享选择器控件的保值契约
domain: editor-tools
type: mechanism
summary: IdRefSelector 等共享控件被约 40 处调用点依赖——未知/悬垂值必须保值展示而非静默顶替或清空,候选去重不得让一部分数据在 UI 上不可达,严格选择器的候选面必须等于校验器同上下文的放行面(逐个宿主面核);一处控件破坏 = 全编辑器数据面污染
status: active
authority:
  - tools/editor/shared/id_ref_selector.py
  - tools/editor/shared/qt_combo_wheel_guard.py
  - tools/editor/shared/audio_picker_dialog.py
  - tools/editor/shared/qt_icon_buttons.py
  - tools/editor/shared/position_ref_field.py
  - tools/editor/shared/form_layout.py#compact_icon_button
triggers:
  paths: ["tools/editor/shared/id_ref_selector.py", "tools/editor/shared/action_editor.py", "tools/editor/shared/qt_combo_wheel_guard.py", "tools/editor/shared/audio_picker_dialog.py", "tools/editor/shared/qt_icon_buttons.py", "tools/editor/shared/position_ref_field.py", "tools/editor/shared/move_entity_map_picker.py"]
  topics: [IdRefSelector, 悬垂引用, select_only, 保值, 滚轮误改, 候选去重, 候选面等于校验面, 弹窗选择器, 位置引用, PositionRefField, at, 地图拾取, 窄按钮]
  tasks: [改共享选择器控件, 把裸输入框换成选择器, 做弹窗选择器]
last_governed: 2026-09-23
---

## 是什么(一句话)

`tools/editor/shared/` 下的选择器控件是全编辑器复用件,它们对"数据里已有但候选清单里没有的值"的处理方式,决定了打开旧数据是否安全。

## 权威源(读代码从哪进)

`id_ref_selector.py`(id 引用选择器)/ `action_editor.py`(`FilterableTypeCombo(select_only)` 的未知值注入)/ `qt_combo_wheel_guard.py`(全局滚轮误改防护,`__main__.py` 安装)/
`position_ref_field.py`(**位置引用 `at` 的统一复合控件**:数字坐标 / 地图拾取 / 实体此刻位置 / 场景曲线插槽 /
曲线上的点;数字模式不写 `at`、老数据一个字节不动;引用档写 `at`,x/y 写编辑期快照当回落,引用没动就保留磁盘 x/y;
候选全部取自 ProjectModel,悬垂值经 IdRefSelector 保值。有的动作实体档映射到老键,见 `ActionRow._add_entity_or_ref_field`)。
哪些动作接了它以代码为准(**并非全部**,见已知坑)。控件选型对照表见 `.cursor/skills/editor-tools-iteration/SKILL.md`。

## 硬契约

1. **未知值保值**:候选清单里找不到当前值时必须保留原值展示(标记为未知即可),**禁止**静默顶替成第一候选或清空——这曾是 P0(悬垂引用一开面板即被改写,约 40 调用点受影响);在控件层修一次覆盖全部调用点,是最高杠杆位。
2. **select_only 组合框接旧数据**:换成只读组合框时,未知旧值以带前缀的条目注入候选,保证旧值不因换控件而丢。
3. **候选一律取自 ProjectModel 的 id-provider**,不自建清单;选定父项后刷新子候选(选 scene 刷 spawn、选 actor 刷动画 state)。

4. **候选去重不是保值问题,是可达性问题**:候选集里存在"**同 id 不同物**"(如跨场景重名实体)时,
   按 id 去重会让**那一部分数据在 UI 上根本不存在,且没有任何提示**——策划配出来的引用永远
   指向第一个同名者。选择器**必须携带消歧维度**(把候选做成 `(上下文, 目标)` 的二元组、或换成
   带上下文列的弹窗)。别用"运行时按当前场景解析"安慰自己:解析不到就是整组静默不响。

5. **"坏元素只读透传"的判据必须是显式标记,不能靠"原值不是 None"**:JSON 里的 `null` 会被
   当成一行正常数据,读表时去取一个并不存在的控件 → 抛异常 → 主窗兜底把**整页**记进跳过集,
   于是那一页的全部编辑**静默不落盘**。给坏元素挂一个显式的原样透传标记。
6. **保值必须与"用户动没动过"配对判断**:只凭"盘上是坏值"就无条件保值,会把用户刚改的值
   又盖回去**且不标脏**——改动凭空消失,而且那个字段从编辑器里**永远修不好**。
   判据要拿载入时的控件快照来比。
7. **候选面 == 校验面**:严格选择器(只能选、不能手输)的候选集合必须等于校验器**在同一上下文**放行的集合,
   最好就是调 `ProjectModel` 的同一个函数。候选比校验窄 → 那一档在编辑器里**根本配不出来**且不报错;
   候选比校验宽 → 能配出校验必拒的值。**同一个控件嵌在多个宿主面**(主编辑器过场 / 场景动作 / 对话图检查器 /
   叙事网页 / 无场景的任务规矩页…),各宿主给的上下文不同,要逐面过一遍——踩过:对话图检查器建上下文时
   场景恒为空,实体下拉只剩过场临时演员,而校验器同上下文放行全工程 NPC;离屏只测了主编辑器那一面,全绿。
   用户说"选不到"而离屏全绿时,先问是哪个编辑器面。**没有通用对账**,只有各功能自己的测试在守。

## 已知坑

- **"裸控件承载引用字段"的护栏只覆盖登记表里的项**(它遍历的就是那张 `(动作, 参数) → 宇宙`
  登记表),没登记的参数落到兜底的裸文本框、**不受任何检查**。2026-09-03 实测现存一例:
  一个调试用动作的两个图/状态 id 参数就是裸框(UI 上挂了危险标签,但打错了没有任何一道门会拦)。
  ⇒ **加了选择器不等于加了护栏**,要先进登记表;审这类问题别只看"有没有测试",要看测试遍历的是什么。
  反向也没护栏:建了选择器却没进那张登记表的参数,json_lang 不做宇宙校验、叙事关联也不把它当目标。
- **位置引用并没有全部收进复合控件**:没有专用表单的动作(粒子播放 / 粒子场两条)的 `at` 仍落在泛型面的
  **裸文本框**里。数据安全那一半已兜住(文本没动就按磁盘原值回写,否则对象形态的 `at` 会被存成 Python repr
  字符串、运行时解析不出、整条动作静默跳过——回归锁 `test_vfx_dict_position_ref_not_stringified`);
  真修法是接上复合控件,属于改作者面、要制作人点头。别以为全项目 `at` 都已经是选择器。
- 滚轮误改:主编辑器有全局 combo 滚轮 guard,但 QSpinBox 不在防护内、独立小工具(未走 `tools/editor/__main__.py` 启动)未安装——评估滚轮风险时别以为全覆盖。
- 未登记 flag 的数值条件曾被 bool 化(类型查询兜底到 "bool")——涉及 flag 类型推断的控件要考虑未登记键。

### 做弹窗选择器时四条 PyQt 死路(踩过,都不是"看着不对"而是硬崩或静默)

- **树项排序覆写里调父类比较 = 无限递归 SIGSEGV**(进程直接 exit 139,不抛异常)。自定义排序
  必须自己给出全序,不能回落到父类实现。
- **开启排序会立刻按"当前指示列"排一次**:想保住原始顺序,必须**先**把排序指示列清成无效,
  再开排序;顺序反了就是"打开弹窗东西全乱了"。
- **后台线程往已析构的 Qt 对象发信号会抛"信号源已被删除"**(全套测试里真的报出来过)。
  断路要用**不持有 self 的共享存活标志**,别用弱引用外的临时补丁。
- **窄图标按钮一律走共享出口**(`shared/qt_icon_buttons`、`shared/form_layout.compact_icon_button`,或 QToolButton):
  现用主题给 `QPushButton` 的左右内边距合计就有 28px,≤30px 宽的单字形按钮字形被整个挤没——按钮还在、还能点,
  只是**看不见**(动作编辑器每行的上移/下移/删除曾长期是三个空色块)。判据与跨字号验收见
  [验证门配方](../recipes/editor-change-verification-gate.md)「布局塌陷」。

## 怎么验证

`tools/editor/tests/test_action_condition_data_safety.py`(悬垂/未知值保值场景);改控件后跑黄金往返 + [验证门配方](../recipes/editor-change-verification-gate.md)。
