---
target: breathing-workbench
date: 2026-09-27
session: wt/breath 呼吸工作台迁 RHI
---

现象: 迁 RHI 前的出片有两处与"同一份代码 = 游戏"的说法不符:① S.rendering 在服务端 begin 返回后才置上,等的那几帧 rAF 按真实时间推表演,成片起点随请求快慢漂(实测 0.067 s);② 层贴图不预乘上传(uPremul=0),半透明边渗出透明像素里的颜色,约 0.5% 像素、最大差 ~60。两处都已修(卡已就地改),GLSL 与 WGSL 本身同口径下只差末位。
证据: F:/gd_wt/breath_out(迁移前后出片逐帧比对 compare_loop_old_vs_new.json、exp/ 下同一 Mesh 不预乘 / 预乘两口径对照);selftest S17「同参数出两次片」。
建议: breathing-overlay 卡的"两份着色本体"一条可在 GLSL 孪生删掉后撤掉;shaderTwins.test.ts 的呼吸图一对同步撤。
