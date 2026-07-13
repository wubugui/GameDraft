---
id: program-drives-agent-judges
title: 素材产线程序驱动、agent 当裁判
domain: asset-pipeline
type: decision
summary: 产线主入口是确定性程序;agent 只做 QA 语义裁决/异常/配方作者;被否=agent 逐条驱动整条管线
status: active
triggers:
  topics: [管线架构, 程序驱动, QA裁决, 分工]
last_governed: 2026-07-11
---

## 背景(一段)

2026-07-04 动画生产管线(tools/animation_pipeline)建成时,与用户多轮敲定的架构定论。
此前的隐忧:让 agent 在对话里逐帧/逐步驱动抠图-循环-打包,慢、贵、且每次跑出来不一样,
毁掉可复现性。

## 决定(一句)

素材产线**主入口是程序**(如 produce.py 驱动确定性流水),**agent 只当被调用的裁判**
(QA 语义裁决,按结构化 schema 回答)+ 异常排查入口 + 配方数据作者;QA 分三态——
硬失败程序判死不花 agent、软 flag 才交 agent 定性、**程序从不单独判"通过"**。

## 被否方案

- agent 当整条管线的驱动逐条跑:慢/贵/飘,不可复现;批量与定时必须走程序入口。
- 程序全自动判"通过"(无 agent 复核):程序指标抓不住语义缺陷(道具丢失/动作错),
  且部分指标本身不可信(halo 分不清灰衣与灰背景)。
