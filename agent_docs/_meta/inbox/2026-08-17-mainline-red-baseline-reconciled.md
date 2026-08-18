---
target: narrative-signal-spine
date: 2026-08-17
session: 主线叙事对账修复（承接 2026-08-07 / 2026-08-17 两条红基线记录）
---

# 主线红基线已对账：测试期望过期 + 内容侧漏迁移，均已修

- **判定**：主线图两次改动均为有意提交（3fb6c1f 加 state_1「未开始」开机旗门控 + Demo主线开始 reactive；
  8f55d04 把 s01_tingshu 并入 initial、出口改显式信号「主线_开局被赶出茶馆」）→ **测试期望过期**；
  同时内容侧 11 处 `s01_tingshu` 条件引用 + 1 处 dev warp flowState 是改图时**漏迁移**（冷启动 [narrative] 悬垂报错源头）。
- **修法**：`reached s01_tingshu` → `reached state_2`（同拍后继锚点，warp 沿链推进天然满足）；
  `active s01_tingshu` → `reached state_2 && !reached s02_beishi` 窗口；背尸 warp flowState → state_4。
  vitest 两套 + narrative_debugger 守护测试改锚到已接线区域；state_2→s02_beishi 段 t_5/t_6 仍是
  `__draft__` 占位（闲逛A/B·去赌坊未接线），集成测试在该缺口用 debugSetNarrativeState 硬跳过渡，
  **接线完成后应删掉硬跳恢复纯信号推进**（validator 也在 WARN 点名 t_5/t_6）。
- **门**：vitest 8/8（全量 820 无新增失败）、debugger pytest 28/28、validate-data 无新增 error（存量 85 个全是
  eco_眼力/时辰/风评 缺图族，见 2026-08-12 记录）、素材审计 0 issues；无头冷启动真跑通开局链
  （听书→被赶→state_2→雾津街头），[narrative] 悬垂状态报错确认消失。2026-08-07 与 2026-08-17 两条红基线记录可视为已结。
- **顺手发现（未修）**：① `scenario_听书.kicked_out` 的 `broadcastOnEnter` 成了死发射端——8f55d04 删掉
  t_s01_tingshu 后全项目无人监听 `state:scenario_听书:kicked_out`，冷启动仍打一条 [narrative] unlistened 报错
  （流程不受影响，主线走显式信号）；② teahouse `teahouse_door_too_early`（门口）热点 `data` 为空载荷，
  条件为真时也进不了 E 交互目标，疑似"太早出门"占位文案没填。
  【② 已修 2026-08-17 后续会话】补了 data.text 内联文案，无头实测已成 E 目标、InspectBox 正常、
  state_2 后按条件退出目标池；双校验门无新增（error 仍 85 存量）。同场实测另见：正常玩法下
  玩家在 reached state_2 前并无茶馆自由移动窗口（开场图推完必发被赶出信号），该热点实际仅
  dev/非常规路径可达——是否要给开场留自由移动窗口属设计问题，未动。
