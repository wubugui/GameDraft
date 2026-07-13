---
id: armed-locomotion-single-image-gen
title: 持械位移动作必须单图生视频
domain: asset-pipeline
type: decision
summary: 持械+位移(走/跑)state 生成必须单图生视频(Seedance);动作迁移被否——会把手中道具甩掉
status: active
triggers:
  topics: [生成动画, 动作迁移, 持械, Seedance]
last_governed: 2026-07-11
---

## 背景(一段)

2026-07-02 动画批量生成(tmp/libtv_animation_batch_run_20260702)中,用动作迁移
(Kling,空手跑参考)生成持械角色的走/跑视频,官差的长枪、角色的铁环在迁移过程中被甩掉,
产出全部报废。

## 决定(一句)

**持械 + 位移动作(走/跑)必须用单图生视频(Seedance 2.0 VIP),禁用动作迁移**;
提示词写死"游戏精灵素材·原地(跑步机)·禁止位移·道具全程握持"。

## 被否方案

- 动作迁移(空手动作参考驱动持械角色):道具不在参考里,迁移必丢道具。
