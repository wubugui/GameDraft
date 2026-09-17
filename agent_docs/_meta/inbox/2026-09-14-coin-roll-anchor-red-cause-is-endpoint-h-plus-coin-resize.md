---
target: trajectory-workbench
date: 2026-09-14
session: HEAD 53f1aa9 两条红测试(test_coin_roll_anchor / scene_workbench test_backend)
---

现象: 卡「已知坑」写 coin_drop_demo「末帧沉地 1.14 wu」且只归为「手改数据」;实际 HEAD 上是 atMs=5217 沉地 1.220 wu,成因是两件事叠加:manual_1 末控制点 h=3.2205 低于 source.bake.restHeight=9.899(支点压进地面),加上 09-12~13 场景里 npc_验证铜钱 displayImage 从 14 wu 缩到 7 wu(8dc0a3d/314414a 同一份帧按 14 wu 算是沉 4.72,53f1aa9 按 7 wu 算是沉 1.22)。资产的 restHeight 9.899 / contactOffsetY 7 仍是 14 wu 铜钱的尺寸,贴地帧上 7 wu 铜钱反而浮空 3.5 wu,这个测试不管浮空,所以没报。
证据: 当前烘焙机 `serve.bake_document(assets.load_asset('coin_drop_demo'))` 重烘出来的 keyframes / worldKeyframes 与落盘逐项相等(烘焙机没回退,重烘修不好);`git show <rev>:public/assets/scenes/雾津街头.json` 看铜钱尺寸:f71b25f/8dc0a3d/314414a 是 14,53f1aa9 是 7。
建议: 已知坑那条改成上述成因;顺带写明「实体改尺寸不会回写资产的 restHeight/contactOffsetY,手绘点 h 是绝对支点高也不跟着变」,改了预览实体尺寸要回工作台「取自预览实体」并下移手绘点 h。
