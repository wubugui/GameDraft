---
id: inventory-capacity-critical
title: 背包槽上限与 critical 给予
domain: runtime
type: mechanism
summary: 背包有槽上限,giveItem 返回值必须消费;关键道具用 critical=true 绕上限,拾取失败走 inventory:full 不消耗热点
status: active
authority:
  - src/systems/InventoryManager.ts
triggers:
  paths: ["src/systems/InventoryManager.ts", "src/ui/InventoryUI.ts"]
  topics: [背包, giveItem, 槽上限, critical, 关键道具]
last_governed: 2026-07-11
---

## 是什么(一句话)

背包是有限槽位(12 槽),给予/拾取可能失败——所有发道具的路径必须处理失败,剧情关键道具走 critical 通道。

## 权威源(读代码从哪进)

`src/systems/InventoryManager.ts`(addItem 的 `bypassSlotLimit` 即 giveItem critical=true 的落点,注释在函数头)。

## 硬契约(违反即 bug)

- **giveItem 返回值不许 void 丢弃**:满包静默失败曾造成剧情关键道具永久不可补领(茶馆铁盒子)。检查返回值+补偿的既有范式是 shopPurchase(失败退款)。
- **关键道具在数据里标 `critical:true`** 绕槽上限;InventoryUI 网格支持溢出增行,不会画崩。
- 拾取热点失败用 `inventory:full` 事件判定、**不消耗热点**(玩家腾位后可再捡)。
- 一次性对话给予前置守卫:发放点靠 narrative 状态防重入,不靠"背包里有没有"判断(满包时该判断为假)。

## 怎么验证

命令通道塞满 12 槽后触发关键道具发放,断言仍到手;普通道具满包拾取断言热点仍在。
