---
id: json-lang-schema-tooling
title: json_lang「JSON=语言」工具链(schema 索引器 + LSP)
domain: editor-tools
type: mechanism
summary: 把数据 JSON 当语言:运行时=解释器、编辑器=IDE、JSON=源码;从权威代码现场重算 schema 供 IDE/LSP 补全与查错;方向永远代码→schema,out/ 不入库,只咨询不裁决
status: active
authority:
  - tools/json_lang/build.py
  - tools/json_lang/schema_build.py#CONTENT_ID_PARAMS
  - tools/json_lang/lsp_server.py
  - tools/editor/shared/lsp_client.py
triggers:
  paths: ["tools/json_lang/**", "tools/editor/shared/lsp_client.py"]
  topics: [json_lang, schema 索引器, LSP, 补全, 查引用, 全局搜索, tripwire, CONTENT_ID_PARAMS]
  tasks: [改json_lang, 加id引用参数, 接LSP, 查引用]
last_governed: 2026-07-15
---

## 是什么(一句话)

把项目数据 JSON 当作一门语言:运行时是解释器、编辑器是 IDE、JSON 是源码。`tools/json_lang/`
是这门语言的 **IDE 索引器 + 语言大脑**——启动时从权威代码 + 真实数据现场重算一份 JSON
Schema,VS Code/Cursor 与常驻 LSP 消费它,打字当场得到 action/条件/ID 引用的补全与悬垂黄线。

## 权威源(读代码从哪进)

- `build.py`(重算入口:`--watch` 常驻、`--validate` 全量过 schema、`--lint` 对话图连边、`--check` tripwire 变退出码)
- `schema_build.py`(schema 生成 + `CONTENT_ID_PARAMS` 登记面:哪个 action 参数是内容 id 引用)
- `lsp_server.py`(标准 stdlib LSP:definition/references/hover/symbol + 自定义 `gamedraft/*` 方法;PyQt 全局搜索/查引用后端)
- `lsp_client.py`(编辑器接入:`mark_dirty` 防抖 800ms 推 overlay,未保存内容实时可见)
- 抽取的权威:`actionParamManifest.ts`(required)、`action_editor.py` 的 `ACTION_TYPES`/`_PARAM_SCHEMAS`、`entity_refactor.py` 的 `ENTITY_REF_PARAMS`、`evaluateGraphCondition.ts`(条件叶)、数据现场(id 宇宙)

## 硬契约(违反即失真)

- **方向永远 代码→schema**:`out/` 是派生缓存(不入库、`.gitignore`);schema 与本体不一致 = 重跑生成器,**绝不手改 schema**。
- **零侵入、只咨询不裁决**:纯 stdlib、只读;Python 权威用 `ast` 静态解析(不 import,避开 Qt 副作用),TS 权威文本解析。不替代任何校验门(validator/编辑器保存门仍是权威裁决),爆炸半径 = IDE 里的波浪线。
- **结构无关深扫描**:不建模文档结构(避免成为 validator 的第四份拷贝),凭签名识别构造(`{type,params}`=action、`*[cC]ondition(s)?`=条件宿主)。
- **宁可少校验不误报**:空宇宙不注入枚举、`str` 参数不约束、跨字段限定做不到就放全局并集、可选引用允许空串。
- **新增含 id 引用参数的 action → 补 `CONTENT_ID_PARAMS` 一行**(并入 [加 Action 四件套](../../runtime/mechanisms/action-registration-quadruple.md) 检查单);权威源形状变化时提取器直接 raise,权威打架/新条件叶/新 ref kind 出 **tripwire WARNING**(`--check` 变非零退出)。
- **刻意不做信号生产-消费对账**:已有 [emitted-signal-catalog](emitted-signal-catalog.md) 权威口径,再造 = 第四份拷贝,违反零侵入铁律。

## 已知坑

- LSP overlay 的镜像表(`overlay_payloads`)对应 save_all 写盘分支——**新增脏桶时必须补一行**,否则该桶未保存内容 IDE 看不见(镜像清单,配 parity)。
- `--validate` 需 `jsonschema` 包(在 `.tools/venv`);server 缺席/启动失败全链路**静默降级**,pytest 环境自动不拉子进程。
- 天花板(按设计接受):`setEntityField.fieldName`、scenario 叶 `status`、`owner`(由 ownerType 定种类)、`[tag:]` 内部引用均不由 schema 管。

## 怎么验证

`python3 tools/json_lang/build.py --validate --lint --check`;并入收尾门 `./dev.sh validate-data`(json_lang 违例见 [content-validation-gate](../../content/recipes/content-validation-gate.md));`refs.py`/`search.py` 命令行查引用与全文搜索与 LSP 同口径。
