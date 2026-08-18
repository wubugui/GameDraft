---
target: narrative-signal-spine
date: 2026-08-17
session: UI 深审修复 marathon(与本条内容无关,跑门时抓到)
---

# 主线叙事集成测试存量红(HEAD 即红,非本轮引入)

- **现象**:`XungouMainFlowIntegration.test.ts` 3 条 + `NarrativePackageDirectorFlow.test.ts` 1 条
  失败,断言「主线 FLOW 初态应为 initial」实得 `state_1`;干净 worktree 检出 HEAD 复跑同红。
- **判定**:与工作树未提交改动无关的说法不成立——HEAD 本身红,说明**已提交的叙事数据或
  测试期望在上一波提交里岔开了**(嫌疑:日夜日程落地那波对主线图初态的改动)。
- **影响**:npm test 全绿门在本仓当前不可达(另有 anim_preview 两个 .mjs "No test suite" 存量);
  收尾门以「不新增失败」为口径。叙事域主人应尽快对账:是测试期望过期还是主线图初态真被改坏。
