---
target: headless-visual-verification
date: 2026-09-11
session: vfx-system
---

现象: 两条像素取证陷阱各骗了我一轮。① `app.ticker.update()` 会跑 `charLitFrameSync` →
`characterLighting.syncFrame()`，把共享的 frameShade 组（uBeta / uGiStrength / uShowN …）
**写回参数值**——凡是「改一个 uniform 再 ticker.update() 取像素」的 A/B 全部无效，
我据此误判成"共享 uniform 组没绑上"。改用 `renderer.render(stage)` 直接出帧才测得准。
② 稀疏粒子用**方框均值** A/B 会被噪声淹没（160×160 框里只有几百个像素在变，均值差 0.02，
看起来像"根本没画"）；改成全画面**逐像素 diff + 变化像素计数 + bbox**，同一场景立刻报出
2414 px、平均差 26.2、bbox 精确框住烟柱。
证据: 本会话义庄 香火烟 的排查全过程；结论在 agent_docs/runtime/mechanisms/vfx-system.md 的「代价」一节。
建议: 把这两条补进 headless-visual-verification 的「坑」；第②条对任何半透明 / 加法混合的效果都成立。

补记(同日晚): ③ 第三条 —— **全画面 diff 出 0 ≠ 没画**。先确认目标在不在相机里:
`mesh.parent.toGlobal({x,y})` 拿全局坐标比画布尺寸。实测滴水锚点在场景 x≈493,
相机跟着玩家停在 x≈1046,算出来全局 x = −704(画布左边外 700 px),diff 自然是 0,
差点当成"渲染坏了"。④ 反过来也要防:**diff 有几千像素但肉眼一片空白**是常态
(义庄尘埃 1434 px / 均值 12.7,截图上什么都看不见)。判据必须"变化像素数 + 截图"两个都过,
只看数字会把低于人眼阈值的效果当成已交付。
