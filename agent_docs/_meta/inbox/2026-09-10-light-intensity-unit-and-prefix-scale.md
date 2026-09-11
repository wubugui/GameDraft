---
target: lighting-scale-reference
date: 2026-09-10
session: gamedraft-b3 实体灯全灭排查与修复
---

现象: 库里 §③ 写"shader 里 march 走 q 所以 intensity 相对 q",而 08-30 起 shader 的 1/r² 已在 wu 且无人折 I;characterLightAxioms 测试注释把"过曝阈值≈I=11000"当成当前尺度——两处都把缺陷当成了设计,铁律 0 欠账表只列长度类、没列强度与前缀灯位。
证据: 真跑雾津街头「夜」uDebug=3 一片黑;uLightPx 实测 −217047 px;fdeedc8 的 lightPacking 去掉 quPerWu 但 intensity 只在数据里 ×3。已修:lightPacking.pointIntensityWu / worldWuToQ,§③、铁律 0 欠账表、scene-lighting 已知坑同步。
建议: 铁律 0 落地清单补一行"凡进 1/r² 的量(含强度)都要换尺";作者面 intensity 是否改成 wu 量纲(跨场景直觉)是制作人的决定,本次未动数据。
