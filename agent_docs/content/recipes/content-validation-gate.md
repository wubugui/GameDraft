---
id: content-validation-gate
title: 内容收尾双校验门(命令与盲点)
domain: content
type: recipe
summary: 每次改完内容 JSON 必跑的两条命令(素材审计 + validate-data)、退出码语义、以及校验抓不到要自己当心的盲点
status: active
authority:
  - tools/editor/shared/asset_reference_audit.py
  - tools/editor/validator.py
  - dev.sh
triggers:
  paths: ["public/assets/data/**", "public/assets/scenes/*.json", "public/assets/dialogues/graphs/*.json"]
  topics: [validate-data, 素材审计, 数据校验, 收尾校验]
  tasks: [做内容, 改JSON, 收尾校验]
last_governed: 2026-08-05
---

**实测环境与日期**:2026-07-11,macOS(darwin),仓库根目录直接跑,两条命令均通过(素材审计 0 issues;validate-data 退出码 0、仅 warning)。

## 命令

1. **素材引用审计**(抓"引用了磁盘上不存在的图/音/动画"):

   ```sh
   python3 -m tools.editor.shared.asset_reference_audit . --strict
   ```

   通过标准:`issues: 0`。

2. **全量数据校验**(抓 action type 未登记、跨文件引用断裂、必填/枚举、`[tag:]` 失效、废弃字段;等价主编辑器 Validate Data):

   ```sh
   ./dev.sh validate-data                  # 或 python -m tools.editor.validate
   ./dev.sh validate-data -- --strict      # warning 也算失败(经 dev.sh 转参要加 --)
   ./dev.sh validate-data -- --errors-only # 只看 error
   ```

   退出码:0=无 error;1=有 error(--strict 下 warning 也算);2=工程加载失败。
   该命令内已串上 json_lang 层:schema 违例记 warning(`--strict` 升级为失败)、**对话图
   悬垂连边/悬垂外部入口记 error**、不可达节点记 warning、json_lang 自身故障降级为 warning
   不拦门。单独访问该层:`./dev.sh json-lang -- --validate --lint`
   (见 [json-lang-schema-tooling](../../editor-tools/mechanisms/json-lang-schema-tooling.md))。

不通过就继续改数据修复再跑,迭代到干净才算完成。

## 校验抓不到、要自己当心的盲点

- **素材文件存在性**——validate-data 不管,靠第 1 条命令。
- **大量引用只报 warning 不报 error**——warning 要逐条看,不能"没 error 就当对了"。

## 相关

契约背景见 [editor-roundtrip-contract](../mechanisms/editor-roundtrip-contract.md);工作流位置见 [production-mode-workflow](../methods/production-mode-workflow.md)。
