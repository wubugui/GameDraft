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
last_governed: 2026-09-03
---

## 是什么(一句话)

把项目数据 JSON 当作一门语言:运行时是解释器、编辑器是 IDE、JSON 是源码。`tools/json_lang/` 是这门语言的 IDE 索引器 + 语言大脑——启动时从权威代码 + 真实数据现场重算 JSON Schema,VS Code/Cursor 与常驻 LSP 消费它,打字当场得到 action/条件/ID 引用的补全与悬垂黄线。

## 权威源(读代码从哪进)

`build.py`(重算入口)/ `schema_build.py`(schema 生成 + `CONTENT_ID_PARAMS` 登记面:哪个 action 参数是内容 id 引用)/ `lsp_server.py`(stdlib LSP,PyQt 全局搜索与查引用的后端)/ `lsp_client.py`(编辑器接入:防抖推 overlay,未保存内容实时可见)。它抽取的上游权威是运行时 manifest、编辑器 action 清单、重构引擎引用参数表、条件叶求值器与数据现场的 id 宇宙。

## 硬契约(违反即失真)

- **方向永远 代码→schema**:`out/` 是派生缓存(不入库);schema 与本体不一致 = 重跑生成器,**绝不手改 schema**。
- **零侵入、只咨询不裁决**:纯 stdlib、只读;Python 权威用 `ast` 静态解析(不 import,避开 Qt 副作用),TS 权威文本解析。不替代任何校验门(validator / 编辑器保存门仍是权威裁决),爆炸半径 = IDE 里的波浪线。
- **结构无关深扫描**:不建模文档结构(避免成为 validator 的第四份拷贝),凭签名识别构造。
- **宁可少校验不误报**:空宇宙不注入枚举、`str` 参数不约束、跨字段限定做不到就放全局并集、可选引用允许空串。
- **新增含 id 引用参数的 action → 补 `CONTENT_ID_PARAMS` 一行**(并入 [加 Action 的登记面](../../runtime/mechanisms/action-registration-registry-surfaces.md));权威源形状变化时提取器直接 raise,权威打架/新条件叶/新 ref kind 出 tripwire WARNING(`--check` 变非零退出)。
- **刻意不做信号生产-消费对账**:已有 [emitted-signal-catalog](emitted-signal-catalog.md) 权威口径,再造 = 第四份拷贝。
- **overlay-only 文件必须并进枚举**(2026-09-03):`read_text` 注入只决定"怎么读",**不决定"读哪些"**——
  文件集来自磁盘 glob,于是编辑器里刚新建、还没 Save All 的场景/图(磁盘上没有这个文件)对整个
  语言大脑不存在:不进宇宙、不进候选、查引用/全局搜索/schema 全部看不见,直到有人想起去保存。
  内容文件的疆域只有一处 `id_universes.CONTENT_GLOBS` + `iter_content_files(root, extra_paths=…)`
  (磁盘 glob ∪ overlay 路径,normcase 去重);`collect_id_universes` / `find_refs` / `find_text` /
  `build._rebuild` 都收 `extra_paths`,server 端一律传 `overlay_paths()`。**新加一条扫描内容文件的
  代码不许再自己写 `root.glob`。** LSP 内的 schema 刷新线程同样以 overlay 为指纹、以 overlay 重算,
  所以 VS Code 的枚举跟着编辑器内存态走;LSP 不可用时编辑器在 Save All / Validate 后兜底重算一次
  (`MainWindow._refresh_json_lang_schema`)。护栏 `tools/json_lang/tests/test_overlay_only_files.py`。

## 已知坑

- LSP overlay 的镜像表(`overlay_payloads`)对应 save_all 写盘分支——**新增脏桶时必须补一行**,否则该桶未保存内容 IDE 看不见(镜像清单,配 parity)。
- **file URI 必须是标准形态 `file:///E:/x`,overlay 键按 normcase 归一**(2026-09-03 实测):此前客户端
  `"file://" + quote(str(path))` 把盘符与反斜杠整串塞进 netloc,server 解回来是 `.`——Windows 上
  所有 overlay 挤在同一个键上、一条都对不上磁盘路径,「未保存内容实时可见」从没成立过而且零报错。
  现在两侧都走 `Path.as_uri()`;server 仍认旧形态,键用 `os.path.normcase`(VS Code 发小写盘符,
  glob 出来是大写)。
- `--validate` 需 `jsonschema` 包;server 缺席/启动失败全链路**静默降级**,pytest 环境自动不拉子进程。
- **"用项目 venv 跑校验"可能静默降级成"没校验"**:`.tools/` 不入库、venv 每台机器各建,
  实测有机器的 venv 里**没有** `jsonschema` 而宿主 python 反而有,于是照卡片跑收尾门只拿到
  `(跳过:当前 python 环境没有 jsonschema 包…)` 却被当成全过。判据就是输出里那行"跳过";
  修复方向是**查 venv 的依赖清单/重建脚本**,不是换解释器绕过、更不是改这张卡。
- 天花板(按设计接受):`setEntityField.fieldName`、scenario 叶 `status`、`owner`、`[tag:]` 内部引用均不由 schema 管。

## 怎么验证

`sh scripts/py.sh tools/json_lang/build.py --validate --lint --check`;并入收尾门 `./dev.sh validate-data`(违例见 [content-validation-gate](../../content/recipes/content-validation-gate.md));`refs.py`/`search.py` 与 LSP 同口径。
