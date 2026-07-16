---
id: beishi-mundane-eerie-redesign
title: 开场背尸重设计(日常铺垫反衬诡异)
domain: content
type: decision
summary: 开场背尸=先做混子糊口零活(零工背尸_done 闸门)铺日常基线,再让背阿秀逐拍崩坏;三个演出增量被否勿复活
status: active
triggers:
  topics: [背尸, 开场, 零工, 阿秀反差, pressure hold]
last_governed: 2026-07-13
---

> **部分被取代(2026-07-12)**:第一单编排"先经零工工头顺序背两具普通尸(工头派活)"
> 已被 [2026-07-12-beishi-first-job-yizhuang-reorchestration](2026-07-12-beishi-first-job-yizhuang-reorchestration.md)
> 取代(改为自由空挡→找活→义庄门口拦活接单,工头只派后续淹尸单);本卡其余内容
> (反差结构、闸门 flag、阿秀段崩坏与被否清单)仍有效。

## 背景

demo 开场原是"一上来直奔背阿秀",没有日常基线,诡异无从反衬。约 2026-06-22 重设计并落地(过全部校验门):关二狗是无所事事的混混,背尸只是他糊口的腌臜零工之一(非职业身份)。

## 决定

开场结构=**混子糊口铺垫 → 阿秀逐拍崩坏**的反差:先经零工工头顺序背两具普通尸(傻瓜档长按,只给钱+念口头禅"凉是凉的,沉是沉的,该是什么样就什么样"),置闸门 flag `零工背尸_done`;阿秀接活 NPC 被 AND 进该闸门,必须先做完零活才解锁。阿秀段在保留原演出的基础上做增量崩坏:变重(fill 上调)、阴风骤停的"太安静"(stopSceneAmbient)、盖脸推镜(setCameraZoom),对话里口头禅卡壳("凉是凉的,沉是——不对,这味儿不是")。

有用的通用结论:`startPressureHold` 是 async await runUntilDone,**一个对话里能顺序排多次长按**;本轮为"阴风骤停"新增了 L2 原语 `stopSceneAmbient`(登记面见 [l2 卡](../mechanisms/l2-action-primitive-registration.md))。

## 被否方案(防翻案)

- **阿秀段加 `abortOnReleaseFromRatio`**(松手即失败)——会 soft-lock 现有 scenario,否。
- **尸体头偏演出**——设计砍掉。
- **`axiu_tune_far` 小调前移进背尸段**——污染信号梯度(信号密度是冷框架的命根),否。
- 一上来直奔背阿秀的旧开场——已被本结构取代。
