---
id: fal-generation
title: fal 生成配方(示意图/插画、多向动画帧、音效)
domain: asset-pipeline
type: recipe
summary: 本项目走 fal 出图/出视频/出音效的实测口径——gpt-image-2.5 出示意图与转面、角色新图的参照喂法;多向动画"图出静帧、视频出动作",整张直出帧表不成立;音效用 seed-audio-1.0(长得像 TTS 但不是),先量起爆点再入库
status: active
authority:
  - sprite_sheet/js/providers/falProvider.js
  - public/resources/runtime/character_setup_refs
  - public/resources/runtime/images/illustrations
  - public/assets/data/audio_config.json
triggers:
  topics: [fal, gpt-image, 出图, 示意图, 说明卡配图, 多方向走路, 八向, 转面, 图生视频, 动作迁移, Kling, Seedance, 音效生成, seed-audio]
  tasks: [给游戏出示意图, 给已有角色出新图, 做多方向行走帧, 生成音效, 换一版音效]
last_governed: 2026-09-23
---

**实测环境与日期**:2026-09-09~10 三把火 / 气味说明卡配图、关二狗 8 向走路两路线对照(产物在本地
`artifact/Dir8Walk_20260910/`,未入库);2026-09-18~19 雷符音效批次。LibTV 那条路见 [libtv-image-generation](libtv-image-generation.md)。

## 通用接入

- 密钥 `FAL_KEY` 在仓库根 `.env.local`(gitignore),走本机代理 `127.0.0.1:7078`。
- 同步 `POST https://fal.run/<model>`(`Authorization: Key <FAL_KEY>`,body = 模型 schema 顶层字段);
  长任务走 `queue.fal.run` 提交 → 轮询 `status_url` → 取 `response_url`。
- 参照图可直接塞 data-URI;**转发给上游厂商的端点(如 Kling)要真 URL**:先走 fal 存储直传拿 `file_url`。
- 余额耗尽的症状是存储直传 403 `User is locked`,不是参数错;用前先确认余额。
- 中文 prompt 用 curl 发要写进文件再 `--data-binary @file`,直接 `-d` 会被 shell 搞坏成 body 解析错误。

## 出图(`openai/gpt-image-2.5/sunburst/{text-to-image,edit}`)

- **先看游戏风格与人设再出图**:角色参照一律取仓里的人设图(`character_setup_refs/` 下该角色那张)+ 对话头像钉脸;
  既有插画的画风参照在 `images/illustrations/`。别的模型"凭题材想象"画出来的东西会被当场打回。
- **给已有角色出新图**:第一参照 = **制作人已经通过的那张同角色图**,再加对话头像钉脸;prompt 写成
  "在第一张基础上**只改** …,其余完全一致",每轮只改一处。只拿人设立绘让模型"重画"会把人画成另一个人。
  交付前先把脸放大与头像对照。出两版给制作人挑,定了再落 `images/illustrations/`。
- 教学/说明卡上的是**示意图**不是插画。**gpt-image-2.5 是[生成底色铁律](libtv-image-generation.md)的唯一例外,
  可以直出透明底**(2026-09-23 制作人裁定,按模型划界);换任何别的模型都回到铁律:纯色实底 + 本地抠图。

## 多方向动画帧

- **整张直出帧表不成立**:图模型一次出 8 向×N 帧,网格/方向顺序都对,但**每行是同一姿势复制**(两次实测一致,钉姿势模板也没用)。
- 可行路线 = **静帧转面交给图模型、动作交给视频模型**:图模型一次出 8 个站姿视向 → 按连通域切开、合成纯色底首帧 →
  逐向视频生成"原地走、不转身" → 拆帧(拆帧的验收见 [对抗验收拆帧法](../methods/adversarial-frame-decomposition.md))。
  生成参照用现役精灵帧,不用穿着不同的 setup 图。
- 视频模型在"正/背面原地走"这题上的 2026-09-10 实测:**Kling v3 pro motion-control**(参考静帧 + 写实"原地走"驱动视频,
  `character_orientation: image`)人不漂、底色保住,是当时唯一合格的;**Seedance 2.0 fast 图生视频**只有首帧锚,
  4 秒内脸漂(侧向那几向当时可用);**Wan 2.2 Animate** 背景炸、人糊。这是单题对照,不是全局禁令——
  **持械位移**另有已拍板的口径,见 [单图生视频决策](../decisions/2026-07-02-armed-locomotion-single-image-gen.md);
  某次批产若制作人钉了模型与流程(如 09-14 Meshy 那批),以那份任务规范为准。

## 音效(`bytedance/seed-audio-1.0`,制作人 2026-09-19 指定)

- 入参 `prompt` / `sample_rate: 44100` / `output_format: wav`,出**立体声**(入库前转单声道)。
- ⚠ 入参像 TTS(有 voice/speed/pitch)、返回文件名叫 `speech.wav`,**它不是在念提示词**——要判就直接听,别为此耗时间。
- 备选(都验过能出音效):ElevenLabs 音效要走 **`/v2` 路径**(根路径恒 400,错误体藏在 `detail` 里)、stable-audio 2.5、mirelo sfx。
- 火山 ark 那条路当前走不通:音效只能借视频模型的伴生音轨,且建 endpoint 要火山 SSO,**只有制作人本人能重新登录**,agent 代不了。
- **生成的音效先量起爆点和尾巴再用**:雷声这类常带一秒多渐强前摇(绑画面就是"先看见、一秒后才响");
  长音要等尾巴衰下去再掐,早掐会"啪"一声断。入库口径见 [sfx-external-sourcing](sfx-external-sourcing.md)。
