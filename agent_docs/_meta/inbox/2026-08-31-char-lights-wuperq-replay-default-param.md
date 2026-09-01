---
target: character-lighting
date: 2026-08-31
session: 「角色不吃实体灯」P0 定位与修复
---

现象（真凶，已修）：`CharacterLightingSystem.setShadowBasis` 的灯重放写成
`this.applyLights(this.pendingLights)` —— **第二参缺省 1 把首次调用存好的
`wuPerQUnit`（雾津街头 880）踩掉**。进场景的真实时序恰好是灯先到（lightingLoader）、
基后到（rebuildEntityShadows）⇒ 每次进场景都必然走重放 ⇒ shader 里 `P = R·q × 1`，
人的坐标缩在 q 尺度（±2）而灯位在 wu 尺度（±几百），**每一盏带距离的灯
（point/spot/area）对角色差 880 倍距离** —— 自「原画 + 加性灯」落地起角色没吃到过
一盏点光。GPU 取证：`gl.getUniform` 读到 `uSMWuPerQUnit=1` 而 JS 侧一切正常、
日志照打「8 盏已喂给 probe 着色」。修复：重放带上 `this.lightWuPerQUnit`；
回归测试 `src/core/characterLightScale.test.ts`（三条：灯先基后 / 基先灯后 / 清灯不复活）。
修复后真机验证：GPU `uSMWuPerQUnit=880`，灯位扫描最亮点 (0,·,-1500) 与人的推算
世界坐标 (83,·,-1513) 吻合，灯贡献随位置/强度单调响应。

伪装术（为什么埋了一天才被抓到）：directional 不吃距离 → 一直正常；probe 底光不经
这条路 → 角色画面正常；场景背景走 SceneLightingPass 自己的组 → 地面被照亮;
观感 =「灯亮地不亮人」→ 指向摆灯参数。与 lighting-scale-reference 已知坑③同族：
**尺度错不报错，只是全灭**。缺省参数 `wuPerQUnit = 1` 的语义是「没标定时 q 即 wu」，
但它同时成了重放路径的隐形陷阱——值得考虑重放/缓存类内部调用禁用缺省参数。

调查中误判过一次「Pixi UniformGroup 不同步」（已撤销那份 inbox）：那是三层测量污染
叠加的假象——隐藏页 rAF 暂停时 canvas drawImage 拿缓存帧；`vFootWorld` 依赖共享帧组的
uWCPos/uWCScale，不调 `syncFrame` 就 extract 会拿陈旧相机基；对照灯摆到了人背面
（N·L<0）。页内验光照的正确姿势：**每次 render 前 `cl.syncFrame(当前 wc)`，读像素一律
`extract.pixels`，读 GPU 真值用 `gl.getUniform`**。

新账订正（2026-08-31 晚）：先前记的「底光吃 β²」是**gamma 换算错误**——sRGB 低值段
是线性段（÷12.92），拿 ^2.2 硬套会把低亮度差放大成假的平方关系。重算后底光与灯都随
β¹ 缩放，无双重 β。灯"看着仍偏弱"主要是①extract 全身均值 vs 理论胸口峰值的统计差
（背光面/AO/腿部把均值拉低 5–10×）；②内容侧 intensity（8–14）配上几百 wu 的灯距，
照度本来就只有原画亮度的 ~10%（场景侧 uDebug=4 实测均值 1.36 vs 原画 14.93）——
夜里显眼的"光池"大头是 emissive 光晕不是照明。这是**调参口径**问题（作者按光晕观感
调强度），不是代码 bug；修好 wuPerQUnit 后作者在 F2/编辑器里重调灯强度即可。

终验补记（同日晚）：修复后真机终验通过——夜里雾津街头,产品通道在人脚边放 I=300 点光,
**纯 ticker 渲染**下人被正确照亮(方向性/距离衰减/光晕位置三者一致),截图存证。
再记两条实验方法论(都踩了):①**页内手动 `cl.syncFrame(wc.x, wc.y, ...)` 是污染源**——
Game ticker 喂 syncFrame 的参数带 DPR/resolution(实测 0.8)修正,手动传裸 `worldContainer.x`
会把角色的 vFootWorld 系统性写歪一两百 wu,表现为"灯照人的位置与光晕位置对不上"。
页内验光照要么让 ticker 自己跑(前置面板恢复 rAF),要么照抄 Game 里 ticker 的实参。
②先前记的"~20 倍缺失因子"随之作废——纯 ticker 下照度与理论一致(I=300 贴脸灯亮度正常)。
③emissive 光晕 gain 随 intensity 线性放大,I 上几百时光晕轰成太阳——光晕 gain 的
缺省(0.3)是按 I~10 的灯调的,重调灯强度时要连着 emissive.gain 一起调。
