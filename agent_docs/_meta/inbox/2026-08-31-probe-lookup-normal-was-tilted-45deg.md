---
target: character-lighting
date: 2026-08-31
session: 角色法线约定对账 → 当日 opus 审计翻案 → 回滚
---

⚠ **本条是翻案后的重写**。本文件的上一版验尸结论（"运行时查表多转了一次 Rᵀ、
应改为图集直出"）**是错的**，据其做的修改当日被审计钉死为回归并已回滚。
留此存档，防止下一轮再按旧结论改一遍。

## 对账里对的部分（维持）

- 制作人的几何论断成立：**图集法线读作世界向量时中性=水平 (0,0,-1)**。
  bake_normal_atlas 的 (gx,-gy,-6) 贴上直立 quad 后轴向恰好是世界 X/Y/−Z。
  烘焙一直是对的，**不需要重烘**。
- **灯循环直接用 n**（世界对世界）也对，08-30 的 R·n 回退正确。

## 错的部分（翻案核心）

"probe 查表也应原样用 n"是**把两件事混为一谈**：

1. SH 载荷的方向基是 **q 空间**——`pipeline.py:_trace` docstring 逐字写着
   "dirs (D,3) in q-space"，且方向被**逐轴各向异性**缩放到体素索引（若是世界方向
   这步缩放没有意义）；base/emit/amb/cov 四本账全在 q。
2. 所以查表方向必须是**世界法线的 q 坐标** `nQ = Rᵀ·n`。(0,-0.707,-0.707)_q
   **就是**世界水平 (0,0,-1) 的正确 q 坐标——上一版把 q 坐标三元组当世界方向读，
   才得出"朝下斜 45°被压暗"的错误诊断。
3. 实测方向恰好相反：拿真实 atlas_l2.bin 逐 probe 算，原样传比 Rᵀ 传
   **暗 23%**（luma 中位比 0.771）；与两次游戏内实测 55→43 = 0.78 吻合。
   当时"看起来仍匹配"是因为两次测量的地面参照换了（54-76 → 40.6），不可比。
4. 同一天写的场景侧 GI 体视图（SceneLightingPass uDebug==7）转了 Rᵀ——
   同一个 probeE 两侧两种读法，四种组合里唯一两边都错的那种。

## 已落的修复

- CharacterLitSprite 查表恢复 `nQ = Rᵀ·n`（probeE/gatherRT/太阳项三处同基）；
- worldSpaceShading.test.ts 那条测试翻回来，并新增"场景侧与角色侧 probeE
  法线口径必须一致"的机械闸（回归正是缺这道闸漏进来的）；
- beta=4.2 是在 Rᵀ 口径下标定的，回滚后**无需重标**。

## 仍开着的口子（下一轮）

- **实验室查看器（viewer/app.js CHAR_FS）与 CharacterShadingFilter 的 filter
  路径把图集法线当 q 原样查**——它们才是与场景侧不一致的一方。filter 路径是
  死码（new CharacterShadingFilter 零非测试引用）；实验室是活的调参口径，
  改它会让实验室预览亮 ~30%、与游戏对齐。改的时候连着核对 app.js 与运行时
  两份手工复制的 probeE/CHAR_FS——**全仓没有任何机械 parity 闸**。
- UnifiedCharacterShader（死码，UNIFIED_CHAR_PATH_ENABLED=false）:330 的
  `dirQ = normalize(uSunDir)` 把同一向量既当世界喂 lcDirectionalLight 又当 q
  喂 lcMarchVisibility——启用前要清账。
- 烘焙器 `_atlas4` 在 nee=1 时把 world 投影的 NEE 账混进 q 基 SH 图集
  （全部 29 份 nee=0，休眠雷）。

顺带三连击的既有竞态（未修,与本次无关）：advanceTimeTo('夜') 后 devLoadScene 的
装载竞态——getter 已返回"夜"但 resolveSceneAppearance 拿到空时段,pendingPhaseSwap
挂起后 drainPendingPhaseSwap 的补切 reloadSceneForPhase 会把 switching 卡死。
可靠复现序:dev_room 里推时段→立刻切场景(约 1/3 概率坏)。值得单独立案修 phase swap。
