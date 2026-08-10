# 偏差记录：dev 远程置态守卫过严，warp 补不出中段铺垫（已修）

- **现实**：`canRemoteEnterState` 原本无状态判定（scenario 图只认 entryState/exitStates），
  把「沿合法边逐跳前进」和「凭空跳级」一并拦死。后果：`enterNarrativeWarp` 对主线图沿链重放、
  对 scenario 子图却只打一发 setState，13 条 dev 跳转里 6 条的 beat 铺垫被守卫拒到零，
  且失败只 console.warn、场景照进 —— 表现为"跳转成功但戏没铺到"，潜伏数轮迭代无人察觉。
- **库内**：`narrative-signal-spine` / `save-restore-contracts` 都没写远程置态这一面；
  守卫拦跳级的**意图**正确（跳级会跳过前序 onEnter），错在实现成了过度近似。
- **已改（2026-08-10）**：守卫改为 from 感知（entry/exit **或**图内已声明的 from→to 边放行）；
  新增 `planRemoteAdvance()` 求逐跳路径（BFS，无路且是 entry/exit 时回退 direct 并标记）；
  warp 主线与 scenario 统一走它 + 逐步落地复核 + 失败经 `reportDevError` 上红色错误面 + 菜单预检 `⚠缺口N`；
  活计图无实例仍拒（防幽灵）但给 `needsRun` 让调用方先 startNarrativeRun。

## 值得升格为机制卡的三条（动这块前必知）

1. **补历史 ≠ 置态**：存档恢复走 `restoreActiveStates` 静默写 map（副作用早已落在各系统档里，
   所以读档从不重播演出）；warp 是造一段从没发生过的历史，副作用无处可取，**必须逐跳补跑 onEnter**。
   两者语义相反，别拿存档那条路去实现 warp。
2. **重放静默三原则**：途经的中间跳跳过阻塞式演出（`REPLAY_SILENCED_ACTION_TYPES`：过场/脚本对话/
   chooseAction/等点击/waitMs/小游戏），只落钱物规矩信号；**最后一跳完整执行**（那是要测的那一拍）。
   清单刻意收**黑名单**：漏登记新演出动作 = warp 卡住（一眼可见），白名单漏登记状态动作 = 铺垫静默缺失（更贵）。
3. **落地复核认 reached 不认 active**：无 trigger 的无条件边会让引擎当场穿过目标状态
   （实例：`scenario_婆子家.hired → at_courtyard`），停在别处但 `hasReachedState` 为真是**正常语义**，
   按 active 相等判定会满屏误报。

## 未处理（用户明确拍板"数据问题不算问题"）

`s01_tingshu` 在 12 处仍是悬垂引用（warp 表 1 + quests/场景×3/包/档案）——主线图重构后该状态已删。
现在 warp 会精准点名它而不再静默跳过。`XungouMainFlowIntegration.test.ts` / `NarrativePackageDirectorFlow.test.ts`
的断言仍写着旧主线形状（起点 `initial`、里程碑 `s01_tingshu`），本次改动前就是红的（4 failed），未动。
