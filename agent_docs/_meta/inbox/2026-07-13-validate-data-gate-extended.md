---
target: content-validation-gate
date: 2026-07-13
session: json_lang 收尾门并入
---

现象: `./dev.sh validate-data` 已在 validator 之后追加 json_lang 检查(schema 全量违例=warning、对话图悬垂连边/悬垂外部入口=error、不可达节点=warning、json_lang 故障降级 warning 不拦门);卡中"校验抓不到的盲点"清单里「对话图内部 next 连边完整性」已由机器看守,不再是人工盲区。
证据: tools/editor/validate.py#_json_lang_issues;tools/dev/launch.py 新增 `json-lang` 子命令;首扫修复:met_paoge_leader/met_jiaobang_leader 已登记 flag_registry、义庄管事 root_gate 空条件已接背尸 carrying 门。
建议: 下轮治理更新 content-validation-gate 卡——命令清单补第三入口(./dev.sh json-lang)、盲点清单删去 next 连边一条、注明 schema 违例的 warning 语义与 --strict 行为。
