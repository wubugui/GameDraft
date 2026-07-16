---
id: scenario-firstclass-retirement
title: scenarios.json 一等公民系统退役
domain: runtime
type: decision
summary: 2026-07-13 拍板退役一等公民 scenario 系统;stage-1 数据侧已落地(scenarios.json 清空、码头两线迁 narrative),stage-2 代码删除待做(届时 6→4 条件叶为 approval①)
status: active
triggers:
  topics: [scenario 退役, 一等公民, scenarios.json, scenarioLine, 条件叶]
last_governed: 2026-07-15
---

## 背景(一段)

`scenarios.json` 一等公民 scenario 系统与 narrative 的 `scenario_*` 子图长期双轨、撞名、消费面窄(catalog 里 status/outcome 惰性,真被消费的字段有限,见 [scenario-catalog-semantics](../mechanisms/scenario-catalog-semantics.md))。寻狗主线的拍子状态机早已全走 narrative 子图([narrative-signal-spine](../mechanisms/narrative-signal-spine.md)),码头两条遗留线(码头水鬼 / 外国人捞箱子,25 个消费点)是最后仍喂 scenario 数据的地方。维护两套编排面无收益。

## 决定(一句)

退役一等公民 scenario 系统,拍子编排统一收敛到 narrative 子图。

- **stage-1(数据侧,2026-07-13 已落地)**:码头两线迁入 narrative `scenario_*` 子图(dock 三子图 + 5 新信号入注册表,看板复用既有 `flow_dock_water_monkey.board_read`);`scenarios.json` 清空为 `{"scenarios": []}`;4 张码头对话图 `meta.scenarioId` 关联删除;死写弃置的询问/真相/outcome/activateScenario/completeScenario 全部无读者删除。
- **stage-2(代码删除,待做)**:`ScenarioStateManager` / `scenario`+`scenarioLine` 条件叶 / 四个 scenario 动作 / Scenarios 面板 / 相关测试删除。**完成前运行时代码仍在但零数据喂养**。
- **stage-2 落地时的连带审批**:条件叶从 6 条减到 4 条(移除 `scenario`/`scenarioLine`)是**不变量变更(approval①)**,需另起审批题,并同步 content norms 不变量4 与 CLAUDE.md §2(后者为冻结路由文件,届时人工处理)。
- 老存档 scenario 进度失联按实体改名先例(demo)**不做迁移**。

## 被否方案(列表,防翻案)

- **保留 scenarios.json 与 narrative scenario_* 双轨并存**:撞名、消费面窄、两套编排面各写一遍,长期维护税,已否决。
- **stage-2 与 stage-1 同轮删代码**:数据侧先落、代码留一轮观察(零喂养但不立即拆),避免一次动到条件叶不变量;分两阶段是刻意选择,非遗漏。
