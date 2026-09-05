---
id: narrative-template-system
title: 叙事状态机模板系统
domain: editor-tools
type: mechanism
summary: 填 taskId 一键派生任务;模板文件编辑器专用运行时永不加载、{{taskId}}__ 信号构造性防撞名、盖章产物全有全无暂存;抽取是整树子串替换故误伤检测必须三层、批量盖章 plan/apply 必须对账现实
status: active
authority:
  - tools/editor/shared/narrative_templates.py#stamp_template
  - tools/editor/shared/narrative_template_batch.py
  - tools/narrative_editor_web/src/templateParamDiscovery.ts
  - public/assets/data/narrative_templates.json
triggers:
  paths: ["tools/editor/shared/narrative_templates.py", "tools/editor/shared/narrative_template_batch.py", "public/assets/data/narrative_templates.json", "tools/narrative_editor_web/*"]
  topics: [叙事模板, 占位符, 盖章, stamp, archetype, 批量盖章, 抽取, 参数发现]
  tasks: [改模板引擎, 建或改叙事模板, 批量盖章]
verified_by:
  - tools/editor/tests/test_narrative_templates.py
  - tools/editor/tests/test_narrative_template_batch.py
last_governed: 2026-08-05
---

## 是什么(一句话)

模板 = 带 `{{name}}` 类型化占位洞的叙事作曲骨架(+镜像 quest+对话桩);盖章(stamp)= 纯 JSON 深度替换,一键派生新任务。

## 权威源(读代码从哪进)

引擎:`tools/editor/shared/narrative_templates.py`;桥:`narrative_state_editor.py` 的模板方法;React 面板:`tools/narrative_editor_web/` TemplatesPanel;数据:`public/assets/data/narrative_templates.json`。

## 硬契约

1. **模板文件编辑器专用,运行时永不加载**:带 `{{...}}` 的模板不是能跑的图,进 narrative_graphs.json 会被运行时当活图注册 + 校验当坏引用。物理隔离是设计,不是疏漏;只有盖章产出的真数据才落运行时文件。
2. **信号防撞名**:模板内信号写 `{{taskId}}__xxx` 形式——emit 端与 listen 端由同一次替换生成,构造性不可能对不上。模板声明的新信号与信号注册表重名 = error 禁盖章(故意不查"实际发出集",查了会误伤先手写对话再盖章的合法流程)。
3. **抽取↔盖章往返无损**:`stamp(extract(comp, samples), samples) == comp`,有单测锁定。
4. **全有全无暂存**(2026-07-10 拍板,见 [决策](../decisions/2026-07-10-template-stamp-all-or-nothing.md)):三产物一并暂存 ProjectModel、零磁盘写,Save All 一处落盘;放弃/崩溃 = 三样全无。quest 脏桶键是**单数 "quest"**(踩过复数键无声丢数据)。
5. 撞名即 error、永不覆盖已有内容;对话桩 id 即文件名,路径逃逸字符 = error;占位符正则与表单允许的参数名必须同口径(**含中文**——历史 bug:表单许中文而 regex 只认 ASCII,盖出字面 `{{任务名}}` 零警告)。

6. **抽取 = 整树子串替换**,所以一个样值会连带改坏**包含它的别的名字**。误伤检测**必须三层,
   缺一层就有静默事故**:
   ① **语料要含"图里用到的信号名",不能只查目录登记 id**——只查目录 id 会漏掉作者信号,
   于是 `<样值>_取走` 被一起挖成占位,盖出的图**监听一个没人发的名字**,那一跳永远不走;
   而校验器**不查"改了名的新信号"**(比断引用更隐蔽)。
   ② **长样值罩住短样值的假阳性,必须拿当前这组样值一起算**(替换按长度降序,短样值轮到时
   命中位置已被更长样值挖成洞);且"**采不采用**"与"**挡不挡创建**"两处**必须同一口径**——
   只修红条那一半 = 显示名参数被白白跳过,N 个实例在画布上仍全同名。
   ③ **信号侧按串边界收敛**(实例 id 编进信号名是正当模式、该挖;撞进无关信号才是意外),
   **且这条只用于实体 id + 信号语料**——目录 id 侧刻意不加边界规则(现网存在互为子串、
   边界又恰好对齐的实体 id,加了会漏报)。这类护栏收窄一律**扫真实数据再拍**,不靠想。

7. **plan/apply 两步式带对账义务**:plan 是纯计算、apply 才落地,**中间世界会变**(对话框开着,
   另一头照样在改)。**每一样要写的东西都得在 apply 期重新对一遍现实**,缺一样即静默数据破坏:
   目标实体还在不在(不在 = 整批不写,否则给不存在的实体留下无主产物、弹窗还报成功);
   这中间有没有被别人写了条件(有 = 跳过不覆盖;**照 plan 期结论盲写 = 吃掉作者刚写的编排**);
   **作曲与信号侧要按 plan 里记的基线比 id 集**——plan 产出的是**整份**叙事快照,
   直接把它拍回模型会把这中间**别处新加的图/注册的信号一并抹掉**。
   判"实体有没有作者条件"的判据必须是**只有确认是空/缺失才写**,不能是"是列表且非空才算有"
   ——坏值(dict / 字符串 / 老数据)会被当空白覆盖掉(对齐 norms:空集合与数组坏元素只读透传)。

8. **模板可声明自己盖哪几样产物**(缺省仍按骨架推断,老模板零改动),参数可声明取值来源
   (绑定被盖实体的字段);全有全无与零磁盘写沿用硬契约 4,**产物必须记出处**(盖自哪个模板、
   哪个版本)。

9. **安全措施不能靠「少做」实现,必须靠「挡住 + 说清楚」**:必需字段永远采用,风险由**显式拦截**
   表达。这是本系统最贵的一条教训——"疑似误伤就不自动采用实体 id"看着安全,实际让模板整个
   **没有实体 id 洞**、每个实体盖出同一份、全绑错人,**比它想防的那个问题坏得多**。
   同理:零洞参数与校验 issue 必须**上屏并禁止创建**,不能只在状态区出个数字、正文只进 tooltip。

## 已知坑

- validate-data 对模板重复 id 的检查必须读**原始磁盘文件**——模型加载已静默去重,读模型是死代码。
- **缺口:批量盖章写整份叙事数据时,叙事网页若开着草稿,会在下次保存把这批作曲覆盖掉**
  (信号侧有"合并宿主独有作者信号"兜底,**作曲侧没有**)。现由场景页开工前的脏草稿闸拦着
  ——那是**拦**,不是真同步;新增会写整份叙事数据的入口时别以为已经安全。

## 怎么验证

`pytest tools/editor/tests/test_narrative_templates.py` + `npm run build:narrative-editor` + `./dev.sh validate-data`。
