---
target: character-probe-bake
date: 2026-09-28
session: wt/charlab 角色照明实验室迁 RHI
---

现象: 卡里「已知坑」第一条(查看器与运行时两份手抄 probe 查表、没有 parity 闸、查看器把图集法线当 q 用)与「是什么」里「运行时在 CharacterShadingFilter.ts 的 GLSL 里查表」已过期——查看器 2D 画面现在就是游戏的 CharacterLightingSystem + CharacterLitSprite(WGSL,charLightCommon.wgsl)+ DepthOcclusionFilter,读的是工作台按 export 公式现场变换的虚拟载荷(serve `/api/game_payload/…`),实验室自己的 GLSL(`/api/char_shade_core.js` 拼 charShadeCore.glsl)已删。
证据: tools/character_lighting_lab/gpu/charLabView.ts;tests/parity/run.mjs(真 GPU 逐字节 6/6)、gpu/charLabView.test.ts(无 GPU 命令流对照)、tests/test_game_payload.py(虚拟载荷 == 真导出逐字节);test_mc_bake 的接缝 / 法线偏移两条改查 charLightCommon.wgsl。
建议: 删第一条已知坑,改写成「查看器 = 游戏着色 + 虚拟载荷,parity 闸是 tests/test_parity.py」;「是什么」里的运行时查表位置改成 charLightCommon.wgsl(mesh 路径)。3D 检视 / 全景 / ⑥面板仍是 CPU 端的 probe 求值(probeFetchJ 等),那一份仍是手抄,另记。
