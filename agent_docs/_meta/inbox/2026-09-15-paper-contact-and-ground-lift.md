---
target: vfx-system
date: 2026-09-15
---
现象: 气流输入不等于脚边接触；旧薄片休眠漏算场景风法向压力，强风下显式二次阻尼会发散，按纸片屏幕位置回收又会把飞高误作出界。
证据: src/systems/vfx/vfxContact.ts、vfxPlate.ts、vfxLifecycle.ts；artifact/paper-interactions-20260915/ 的正式配置真地形回放、角色实走、编辑器往返及校验报告。
建议: 区分接触冲量与空气速度；surface 补回按正下方地面点判界，强风验收同时看真实离地高度、有限数值与回落，不能拿空中补回或对照位移当起飞证据。
