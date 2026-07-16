# frontmatter schema(机器契约)

> `_meta/audit.py` 的解析器是本 schema 的权威实现:它解析不了的写法就是不合法写法。
> 仅支持受限 YAML 子集:`key: 标量`、`key: [a, b]` 行内列表、`- 项` 块列表、
> `triggers:` 下一层嵌套。不支持多行字符串、引号转义、锚点引用。

## 字段总表

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 全部 | 稳定 slug,kebab-case。须等于文件名主干(decision 为去掉日期前缀后的主干) |
| `title` | 全部 | 短中文标题(进 INDEX) |
| `domain` | 全部 | `runtime` \| `editor-tools` \| `content` \| `asset-pipeline` \| `meta`,须与所在目录一致 |
| `type` | 全部 | `norm` \| `method` \| `mechanism` \| `recipe` \| `decision`,须与所在子目录一致 |
| `summary` | 全部 | 一行钩子(进 INDEX 的就是这行,写给要决定"读不读全文"的 agent) |
| `status` | 全部 | `active` \| `suspect`(标疑,待治理确认)\| `superseded`(被取代,正文顶部注明被谁) |
| `authority` | mechanism/recipe 必填 | 权威源锚点列表,形式见下;audit 机械校验 |
| `triggers` | decision 外必填 | `paths`(路径 glob 列表)/`topics`(主题词)/`tasks`(任务形状词),至少一项非空 |
| `verified_by` | 可选 | 绑定行为断言的测试文件路径列表(测试在=断言活) |
| `last_governed` | 全部 | `YYYY-MM-DD`,治理 run 盖章,禁止手写更新 |
| `last_used` | method 可选 | `YYYY-MM-DD`,最近一次被实际使用;久未用触发标疑分诊 |

## authority 锚点形式

- `src/systems/PlaneReconciler.ts` —— 具体文件,校验存在
- `src/systems/plane/**` —— glob,校验至少命中一个文件
- `src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST` —— 文件#符号,校验文件含该符号

## 文件命名与位置

```
<域>/norms.md                        # type: norm,每域至多一篇,id 固定为 <域>-norms
<域>/methods/<id>.md                 # type: method
<域>/mechanisms/<id>.md              # type: mechanism
<域>/recipes/<id>.md                 # type: recipe
<域>/decisions/<YYYY-MM-DD>-<id>.md  # type: decision,日期=拍板日
```

## 模板

### mechanism(机制卡,限一页)

```markdown
---
id: plane-system
title: 位面系统
domain: runtime
type: mechanism
summary: 一行钩子
status: active
authority:
  - src/systems/PlaneReconciler.ts
  - public/assets/data/planes.json
triggers:
  paths: ["src/systems/Plane*", "public/assets/data/planes.json"]
  topics: [位面, plane]
verified_by:
  - src/systems/PlaneReconciler.test.ts
last_governed: 2026-07-11
---

## 是什么(一句话)
## 权威源(读代码从哪进)
## 硬契约(违反即 bug 的机制约束)
## 已知坑
## 怎么验证
```

### method(工作法,骨架限一页)

```markdown
---
id: animation-matting
title: 动画抠图工作法
domain: asset-pipeline
type: method
summary: 一行钩子
status: active
triggers:
  tasks: [抠图, 新角色动画, 重扣]
  topics: [抠图, matting]
last_governed: 2026-07-11
last_used: 2026-07-10
---

## 适用时机
## 阶段骨架(每阶段:目的 + 完成判据,不写怎么达成)
## 判断点(哪里要现场判断,拿什么证据判)
## 分工契约(程序做什么 / agent 裁什么 / 人拍什么板)
## 已知死路(链 decision)
## 向下指针(确定性部分 → recipe / 机制卡)
```

### decision(决策记录,append-only)

```markdown
---
id: unknown-action-failopen
title: 未知动作容错取向
domain: runtime
type: decision
summary: 构建期 fail-closed;运行时 dev 响、prod 跳过
status: active
triggers:
  topics: [fail-open, 未知动作]
last_governed: 2026-07-11
---

## 背景(一段)
## 决定(一句)
## 被否方案(列表,防翻案)
```

norm 与 recipe 结构自由,但 norm 必须含"不变量/过程义务/验收门/红线"四节,
recipe 必须含"实测环境与日期"一行。
