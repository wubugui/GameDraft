---
target: 新工具收编(建议入 editor-tools 或 meta 域)
date: 2026-07-13
session: JSON=语言 工具链第一块
---

现象: 新增 tools/json_lang/(纯 stdlib、只读、零侵入)——启动时从权威代码(actionParamManifest.ts / ACTION_TYPES / ENTITY_REF_PARAMS / evaluateGraphCondition.ts)+数据现场重算 JSON Schema,.vscode 挂载后 IDE 内直接获得 action/条件/ID 引用的补全与 typo 黄线;方向铁律=代码→schema,out/ 不入库。
证据: tools/json_lang/README.md;首扫即抓到 validate-data 盲区(archive discoverConditions 引用未登记 flag met_paoge_leader/met_jiaobang_leader;义庄管事 root_gate 空 flag 占位条件)。
建议: 下轮治理 run 评估是否立卡(机制卡:签名式深扫描/宁可少校验不误报/tripwire 清单);新增含 id 引用参数的 action 时 CONTENT_ID_PARAMS 需补行——可并入 add-game-action 四件套检查单。
补充(同日二轮): 已扩至 跨字段收窄(场景→出生点/zone/hotspot/实体、bookType→条目、narrative→state、scenario→phase)+enumDescriptions 中文旁注+defaultSnippets 脚手架+--lint 对话图连边(外部入口按 InteractionCoordinator 三通道建模)+refs.py 查引用 CLI;信号对账**刻意不做**(emitted-signal-catalog 已有权威口径,再造=第四份拷贝)。
