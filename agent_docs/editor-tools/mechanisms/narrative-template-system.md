---
id: narrative-template-system
title: 叙事状态机模板系统
domain: editor-tools
type: mechanism
summary: 填 taskId 一键派生任务;模板文件编辑器专用运行时永不加载、{{taskId}}__ 信号构造性防撞名、盖章三产物全有全无暂存
status: active
authority:
  - tools/editor/shared/narrative_templates.py#stamp_template
  - public/assets/data/narrative_templates.json
triggers:
  paths: ["tools/editor/shared/narrative_templates.py", "public/assets/data/narrative_templates.json", "tools/narrative_editor_web/*"]
  topics: [叙事模板, 占位符, 盖章, stamp, archetype]
  tasks: [改模板引擎, 建或改叙事模板]
verified_by:
  - tools/editor/tests/test_narrative_templates.py
last_governed: 2026-07-11
---

## 是什么(一句话)

模板 = 带 `{{name}}` 类型化占位洞的叙事作曲骨架(+镜像 quest+对话桩);盖章(stamp)= 纯 JSON 深度替换,一键派生新任务。

## 权威源(读代码从哪进)

引擎:`tools/editor/shared/narrative_templates.py`(substitute/extract_template/stamp_template/validate_*);桥:`narrative_state_editor.py` 的模板方法;React 面板:`tools/narrative_editor_web/` TemplatesPanel;数据:`public/assets/data/narrative_templates.json`。

## 硬契约

1. **模板文件编辑器专用,运行时永不加载**:带 `{{...}}` 的模板不是能跑的图,进 narrative_graphs.json 会被运行时当活图注册 + 校验当坏引用。物理隔离是设计,不是疏漏;盖章产出的真数据才落运行时文件。
2. **信号防撞名**:模板内信号写 `{{taskId}}__xxx` 形式——emit 端与 listen 端由同一次替换生成,构造性不可能对不上。模板声明的新信号与信号注册表重名 = error 禁盖章(故意不查"实际发出集",查了会误伤先手写对话再盖章的合法流程)。
3. **抽取↔盖章往返无损**:`stamp(extract(comp, samples), samples) == comp`,有单测锁定。
4. **全有全无暂存**(2026-07-10 拍板,见 [决策](../decisions/2026-07-10-template-stamp-all-or-nothing.md)):盖章三产物一并暂存 ProjectModel、零磁盘写,Save All 一处落盘;放弃/崩溃 = 三样全无。quest 脏桶键是**单数 "quest"**(踩过复数键无声丢数据,现有 raise 护栏)。
5. 撞名即 error、永不覆盖已有内容;对话桩 id 即文件名,路径逃逸字符 = error;占位符正则与表单允许的参数名必须同口径(含中文——历史 bug:表单许中文而 regex 只认 ASCII,盖出字面 `{{任务名}}` 零警告)。

## 已知坑

- validate-data 对模板重复 id 的检查必须读**原始磁盘文件**——模型加载已静默去重,读模型是死代码。

## 怎么验证

`pytest tools/editor/tests/test_narrative_templates.py`(引擎往返/撞名/桩 schema/格式保真/中文往返等)+ `npm run build:narrative-editor` + `./dev.sh validate-data`。
