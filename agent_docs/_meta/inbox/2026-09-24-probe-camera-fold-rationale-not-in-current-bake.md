---
target: character-probe-bake
date: 2026-09-24
session: 87e87225（接触 AO 综合光照方向只读模拟）
---

现象: CharacterShadingFilter 的 A7 折叠（probeQueryN，n.z<0 翻 z）理由写的是"朝相机方向被饿死、差 13×"，但雾津街头夜/午当前烘焙不折叠时 E(朝相机)/E(背相机) 中位 1.47/1.51，比值 <1/3 的只占 0.1%/1.7%；且 45° 俯角场景里世界"正上方"的 nQ.z = −0.707，整个上半球查表都被折成背相机那半球（E_fold(up)≈E_nofold(世界+z)）。
证据: scratchpad 87e87225…/combined_dir_sim_v2/ 的 table_v2_summary.json、*_profile.json（JS 移植与游戏 GLSL 交叉核对到 4e-6）。
建议: 懂烘焙的一方复核折叠在"逃逸缺省地板色"之后是否仍必要；角色受光的顶面现在吃的是背相机水平方向的 E。
