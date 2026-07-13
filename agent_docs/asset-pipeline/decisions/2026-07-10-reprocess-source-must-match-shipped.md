---
id: reprocess-source-must-match-shipped
title: 重扣源必须=游戏当前源
domain: asset-pipeline
type: decision
summary: 重扣/重生成已上线素材,源以 shipped atlas.meta.json 的 packMode/source 查证;videos_stabilized 被否(更晃+过时,已删)
status: active
triggers:
  topics: [重扣, 素材源, videos_stabilized, packMode]
last_governed: 2026-07-11
---

## 背景(一段)

2026-07-10 对 24 个"严重抠图角色"重扣时,初期误用
`tmp/libtv_animation_batch_run_20260702/videos_stabilized/` 当源,用户震怒。查证结果:
①该目录名不副实,反而更晃——idle 相邻整帧位移(phaseCorrelate)实测 raw `videos/`
max 0.18–0.34px,videos_stabilized max 1.05–2.22px(生成时本来就是原地跑步机);
②它已过时——线上 9 个鞋子返修角色(boy_ring/ascetic_monk/coolie_a·b·c/lifu/player/
player_taoist/+v1)的实际源是 `tmp/footwear_animation_update_20260708/videos/`
(shipped `atlas.meta.json` packMode=`libtv_footwear_animation_update`),用旧目录等于
把新鞋子还原成旧鞋子。该目录已被用户删除。

## 决定(一句)

重扣/重生成任何已上线素材,**源必须 = 游戏当前实际源**——以 shipped
`public/resources/runtime/animation/<role>/atlas.meta.json` 的 packMode/source 逐角色查证,
且优先 raw 原片,禁止凭目录名(如"stabilized")猜源。

## 被否方案

- `videos_stabilized` 当源:实测比 raw 更晃,且内容过时;目录已删,勿再从备份复活。
- 全体角色用同一个源目录:不同角色的现役源不同(原片 vs 鞋子返修),必须逐角色按 meta 分流。
