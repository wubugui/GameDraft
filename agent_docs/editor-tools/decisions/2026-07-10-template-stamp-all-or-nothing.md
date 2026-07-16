---
id: template-stamp-all-or-nothing
title: 模板盖章产物全有全无暂存
domain: editor-tools
type: decision
summary: 盖章三产物(合并叙事图+镜像quest+对话桩)一并暂存 ProjectModel、零磁盘写,Save All 一处落盘;放弃/崩溃=三样全无
status: active
triggers:
  topics: [叙事模板, 盖章持久化, 全有全无]
last_governed: 2026-07-11
---

## 背景(一段)

叙事模板盖章一次产出三样东西:合并进 narrative_graphs 的作曲、镜像 quest、对话桩文件。早期实现是分裂持久化(不同产物走不同落盘时机),存在"盖到一半崩溃留孤儿数据"的风险;2026-07-10 制作人拍板改为原子化。

## 决定(一句)

盖章确认 = 三样产物**一并暂存**进 ProjectModel(各自 mark_dirty 对应脏桶)、**零磁盘写入**;主编辑器 Save All 一处一次落盘全部;放弃或崩溃 = 三样全无、无孤儿;合并叙事图先过保存校验,有错零副作用。

## 被否方案(列表,防翻案)

- **分裂持久化**(旧实现):部分产物即时写盘、部分暂存——崩溃/放弃会留下不成套的孤儿数据,已被本决定替换。
- 盖章时直接写盘绕过 Save All——破坏"save_all 是唯一写盘出口"的机制(见 editor-tools 域 save-all-dirty-buckets 机制卡)。
