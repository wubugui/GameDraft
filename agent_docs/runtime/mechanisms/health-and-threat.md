---
id: health-and-threat
title: 血量·威胁·护火(夜间生存的伤害链)
domain: runtime
type: mechanism
summary: 血量有两条写入通道——玩法伤害走 applyDamage(护盾/下限/耗尽→系绳或死亡),编排置数走 setHealth(永不致死);威胁按距离扣血、有火即驱退;"演出态"= 非 Exploring,普通动作批期间普通威胁冻结;player_health / player_fire_protected 是派生 flag 只读
status: active
authority:
  - src/systems/HealthSystem.ts#applyDamage
  - src/systems/HealthSystem.ts#setHealth
  - src/systems/HealthThreatSystem.ts
  - src/systems/FireProtectionSystem.ts
  - src/data/survival.ts
  - public/assets/data/game_config.json
triggers:
  paths:
    - "src/systems/HealthSystem.ts"
    - "src/systems/HealthThreatSystem.ts"
    - "src/systems/FireProtectionSystem.ts"
    - "src/data/survival.ts"
  topics: [血量, 三把火, 离死之距, 伤害, damagePlayer, 威胁, healthThreat, 鬼, 扣血, 护火, 火光, fireProtection, 系绳, death tether, 下限, 防护]
  tasks: [加一个会扣血的东西, 调威胁半径或伤害, 做护火教学, 做不死的教学段, 排查为什么不扣血]
verified_by:
  - src/systems/HealthSystem.test.ts
  - src/systems/HealthThreatSystem.test.ts
  - src/systems/FireProtectionSystem.test.ts
  - tools/editor/tests/test_health_authoring.py
  - tools/editor/tests/test_health_threat_authoring.py
last_governed: 2026-09-23
---

## 是什么(一句话)

`HealthSystem` 是血量的唯一真相;场景里挂了 `healthThreat` 的 NPC / 热点按距离持续扣血(`HealthThreatSystem`),
玩家在有效火光里时威胁被驱退(`FireProtectionSystem`);耗尽时要么剧情系绳、要么进死亡
(见 [death-and-retry-checkpoint](death-and-retry-checkpoint.md))。

## 权威源(读代码从哪进)

`HealthSystem`(两条写入通道、下限、防护、系绳);`HealthThreatSystem`(在场判定、驱退、信号、选靶);
`FireProtectionSystem`(火光读数);三者的依赖都由 `Game` 组装层注入(可更新闸、火源清单、在场判定)。
数值配置在 `game_config.json` 的 `health`(阈值、回落值、系绳资格条件、护火挂件白名单)。

## 硬契约(违反即 bug)

- **两条写入通道语义不同**:玩法伤害一律 `applyDamage`(防护减免 → 下限钳 → 判耗尽 → 系绳或死亡);
  编排的置数 / 增减走 `setHealth`,**只置数、永不触发死亡**,回到阈值以上还会清掉耗尽。"扣到 0 就死"要走伤害通道。
- **耗尽先闸住再发事件**;系绳资格由配置里的条件表达式决定,显式触发系绳同样要资格。系绳期间不是死亡态;
  系绳动作的 handler 必须 return 整段 Promise(批内后续动作要等演出完)。
- **下限取交集、冲突拒绝;任一正下限 = 不死**(即使阈值 > 0)。scene 作用域的下限只在**真换场**时释放,同场景读档保留。
- **防护**:被动来源来自背包里带 `healthProtection` 的物品,主动来源按游戏时间倒计时;加上限不隐含回血。
  背包必须先于血量系统反序列化。异步尾巴靠世代闸,读档是原子恢复(不重播伤害、不逐条广播)。
- **威胁可更新闸**:无说明卡、未耗尽、状态 ∈ 探索 / 过场 / 动作批 / 对话;遭遇、小游戏、面板期间整条不跑。
- **"演出态" = 非 Exploring(含 ActionSequence)**:演出态里只有 `duringPresentation: true` 的威胁结算,其余冻在原状态
  (不补发进出信号、不扣血)。
- **在场判定**与实体显隐同一判据(基底可见 + 实体条件 + 威胁条件,被隐藏时要 `affectsWhenHidden`);
  `nightOnly` 缺省即"只在夜里",写 `false` 才全天。收靶(落雷)与伤害自停因此是同一件事。
- **有火且 `fireResponse` 不是 `ignore` ⇒ 驱退、不扣血**。火源两类:手持白名单里的挂件(要有生命值与燃料)与带
  `fireProtection` 的热点;熄灭缓冲只给**真燃烧过且仍在半径内**的来源,离开半径立即失效。换场景先 `refresh` 再算,不沿用上一场景的火光。
- **信号只在状态边沿发一次**;存在声在实体**自己**的位置按间隔发——"有人跟着你"不是它,是跟脚声
  (见 [footstep-and-spatial-audio](footstep-and-spatial-audio.md))。
- **`player_health` / `player_max_health` / `player_fire_protected` 是引擎派生 flag**:条件里读,内容绝不写
  (flag 纪律,见 content norms)。
- 威胁与护火不进存档(`scene:ready` 整份重建,换场前 / 读档 clear)。

## 已知坑

- **普通动作批(ActionSequence)期间普通威胁冻结**:一段长 `waitMs` 的检视批就是免伤窗口。要"背景演出时鬼照打"
  用脱手演出(不切状态),或给威胁标 `duringPresentation`。
- 主动防护倒计时只在探索分支推进:对话 / 过场 / 动作批期间不耗时,而 `duringPresentation` 的威胁照样扣血。
- 同一帧里从探索切进对话 / 动作批时,护火与威胁会在两个分支各 update 一次(该帧吃 2×dt)。
- 群体粒子的"侵扰"是另一条伤害通道(只在探索态、直接 `applyDamage`),**不经威胁系统、不看护火**。
- 系绳的"外部接管"抑制 flag 在数据里零写入方;在 flag 纪律下内容也不该写它——这条分支实际不可达。
- 半径是场景坐标距离(2D),不是 M-world。
- `damagePlayer` 是旧入口,走普通伤害通道:获准才系绳,否则是真死亡(旧注释"走系绳"已过时)。

## 怎么验证

`npx vitest run src/systems/HealthSystem.test.ts src/systems/HealthThreatSystem.test.ts src/systems/FireProtectionSystem.test.ts`
+ `sh scripts/py.sh -m pytest tools/editor/tests/test_health_authoring.py tools/editor/tests/test_health_threat_authoring.py`。
真机读 `healthThreatSystem.snapshot()`(每个威胁的状态 / 距离 / 当前攻击力)与 `fireProtectionSystem.snapshot()`。
