---
id: text-ref-tag-system
title: 文本引用系统([tag:…])
domain: content
type: mechanism
summary: 玩家可见文本统一经 resolveText 解析 [tag:…];存档永远存 raw、JIT 解析;扩展须运行时+编辑器三件套一致;引用目标不存在则整工程存不了
status: active
authority:
  - src/core/resolveText.ts
  - tools/editor/shared/tag_catalog.py
  - tools/editor/shared/rich_text_field.py
  - tools/editor/shared/ref_validator.py
triggers:
  paths: ["src/core/resolveText.ts", "tools/editor/shared/rich_text_field.py"]
  topics: [tag引用, resolveText, RichTextField, 文本引用, 富文本]
  tasks: [写文案, 加引用类型, 加展示位置]
last_governed: 2026-07-11
---

## 是什么(一句话)

所有玩家可见字符串经同一 `resolveText(raw, ctx)` 解析 `[tag:…]` 引用(物品名/flag/字符串等),数据里只存 raw,展示边界处 JIT 解析。

## 权威源(读代码从哪进)

- 运行时解析:`src/core/resolveText.ts`(未知 kind 保持原样并 warn)。
- 编辑器三件套:`tag_catalog.py`(kind 清单/存在性校验)+ `rich_text_field.py`
  (RichTextLineEdit/TextEdit + 插入引用对话框)+ `ref_validator.py`(正则扫描 + save 前校验)。

## 硬契约

- **存档永远存 raw**:禁止在数据 load 时解析并写回内存结构;解析只发生在"进 UI 之前"的
  唯一边界,且统一走 `resolveText`,不为单个 UI 另写解析。
- **引用目标必须存在**:save 时 `validate_refs_for_save` 失败即 `raise`,整工程存不了;
  strings 之间不得有引用环;顺序是"先 `{var}` 插值,再 resolve"。
- **扩展新 kind 三面齐才算完成**:运行时 resolveText 分支 + 上下文数据源注入 + 编辑器
  三件套(catalog/插入 UI/校验正则)全部同步——缺一即"运行时能解析但人类没法插/校验放行假引用"。
- **新展示位置**要同步登记字段路径到 copy_manager/ref_validator 的扫描规则,否则 save 前校验覆盖不到。

## 已知坑

- 人类流程禁手打 `[tag:…]`(必须经插入对话框);agent 直接写 JSON 时必须自证目标存在,
  否则害人类存不了工程。
- `[img:…]` 只有档案富文本有 GUI 按钮,其它位置属编辑器盲区(=L2 升级信号,别乱写)。

## 怎么验证

主编辑器 Validate Data(已合并 embedded refs 校验)+ 试保存;扩展步骤细节见 `.cursor/skills/add-text-ref/SKILL.md`。
