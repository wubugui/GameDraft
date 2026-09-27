---
target: character-lighting
date: 2026-09-28
session: wt/glsl 删游戏代码里已无消费者的 GLSL 孪生与 glProgram
---

现象: 燃烧 / 呼吸 / 光柱 / 雷 / 粒子 / 实体阴影 / 前景覆盖图 / 各滤镜的 GLSL 孪生与 glProgram 已删(相关卡已顺手改),character-lighting 卡第 60 行仍写「ENTITY_SCENE_LIGHTS_GLSL 是角色 mesh 与粒子受光共用的同一段」——粒子现在拼的是 ENTITY_SCENE_LIGHTS_WGSL,GLSL 版只剩 CharacterLitSprite 自己的 GL 程序在用。
证据: `git grep -n "ENTITY_SCENE_LIGHTS_GLSL" -- src`(只剩 CharacterLitSprite.ts 与 shaderTwins.test.ts);剩余 GLSL 全在角色照明一线(charShadeCore.glsl / lighting/*.glsl / CharacterShadingFilter / CharacterLitSprite / src/rendering/lighting/*.ts 的 GL 程序 / foregroundMaskGlsl.ts 的 FG_OCCLUSION_GLSL),见 shaderTwins.test.ts 头注释。
建议: 角色照明实验室迁完、那一线 GLSL 删掉时一并改 character-lighting 卡(「着色核心单一 GLSL 源」「一对孪生」两处)并删 shaderTwins.test.ts 剩下的几对;render_parity 候选侧已能从 master 补缺的 .glsl 文件,删 TS 里的 GLSL 导出时 10_lighting_chunks 要改成按命名空间取。
