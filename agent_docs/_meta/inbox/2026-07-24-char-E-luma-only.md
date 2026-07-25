---
target: entity-lighting
date: 2026-07-24
session: 角色融入场景 —— E 只出明暗
---

现象: CHAR_FS 把 sprite 图集像素当 albedo × E，但 sprite 像素是美术**着色后的 color(自带颜色)**、不是反照率；probe/E 是「场景当光源」烘的、**带场景色、只作用于角色**（背景/画死元素不受 E）。于是 albedo×E = 二次着色——角色被场景色染两次、明暗叠加，对比过高、与不受 E 的场景对不上。曾想用 characterGrade（把角色往场景色拟合）救，是**错方向**：在无 E 的素材域拟合、却应用在有 E 的显示域 → 过冲(≈幂次放大)，且编辑器画布无 E 会骗人。已整体拆除。
证据: 决策 = 角色缺的是**明暗**不是颜色 → E 改为只出明暗(luma)、角色保留自己颜色。`src/rendering/CharacterShadingFilter.ts:414` `float lumaE=dot(E,vec3(.2126,.7152,.0722)); E=mix(vec3(lumaE),E,uEChroma);`；uEChroma 默认 0(纯明暗)，F2「E色度」旋钮 0~1 实时对比(1=旧彩色 E)。characterGrade 全拆(5 运行时文件 + scene_editor + validator + 3 个 shared + 测试)，tsc / 329 单元 / 编辑器构造+往返 / validate-data 全绿。**待真机验 uEChroma 默认值**。
建议: entity-lighting 机制卡记「sprite 是着色后 color、E 只出明暗、角色自带颜色不被场景色染」这条不变量；若真机验证需 per-scene 调融入度，再把 uEChroma 从全局 F2 测试旋钮升为 SceneData 字段 + 编辑器控件（现不入存档）。
