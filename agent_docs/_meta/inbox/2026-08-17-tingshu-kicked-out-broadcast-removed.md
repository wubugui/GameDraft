---
target: narrative-signal-spine
date: 2026-08-17
session: 听书 kicked_out 死广播处理（闭环 2026-08-17 对账记录"顺手发现①"）
---

# scenario_听书.kicked_out 的 broadcastOnEnter 已去掉（设计决断 A，与用户对齐）

- **决断**：与用户对齐后选 A——去掉广播，非 B（保留+白名单）。依据：8f55d04 有意把该拍改显式信号
  `主线_开局被赶出茶馆`（寻狗_听书开场 n_2 实发）且链路已验证；广播无任何消费者（包 done 走 reached
  记录、run 结算靠出口态本身、无计划文档预约）；signal.unlistened 与 state.broadcast.unused 均无
  现成白名单机制，选 B 需新建豁免机制。
- **改法**：`broadcastOnEnter` true→false（显式写 false 对齐编辑器取消勾选惯例，先例：主线
  xungou_demo_main.initial）。将来真要接线，编辑器状态面板勾回即可，完全可逆。
- **门**：validate 85 error 与当日基线持平（无新增）、state.broadcast.unused 警告消失；
  XungouMainFlowIntegration 7/7、NarrativePackageDirectorFlow 1/1 通过。
- 注意：主线其余拍仍全走 `state:scenario_*:出口` 广播监听（13 广播态余 12 全被监听），听书是
  唯一显式信号例外——理解脊椎时别把它当漏配。"顺手发现②"（teahouse_door_too_early 空载荷）仍未处理。
