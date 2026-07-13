---
id: sfx-external-sourcing
title: 音效外采与入库配方
domain: asset-pipeline
type: recipe
summary: OpenGameArt/BigSoundBank/Freesound 三渠道下载法 + 许可署名义务 + ogg 必转码 + 入库三件套
status: active
authority:
  - public/assets/data/audio_config.json
  - public/resources/runtime/audio/ATTRIBUTION.md
triggers:
  paths: ["public/resources/runtime/audio/**", "public/assets/data/audio_config.json"]
  topics: [音效, 外采, sfx, 音频素材, 署名]
  tasks: [找音效, 下载音效, 音频入库]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-02~03,说书过场音效外采(sfx_jingju_luogu 等,curl 直下)。

## 渠道配方

- **OpenGameArt**:文件直链 `opengameart.org/sites/default/files/...` 可直接 curl。
- **BigSoundBank**:有防盗链——先 `curl -c` 访问页面拿 cookie,再 `-b` 带 cookie 下载。
- **Freesound**:正式下载要登录;但预览 CDN 公开:
  `cdn.freesound.org/previews/<id 前 3 位>/<id>_<uid>-hq.mp3`。

## 义务与格式

- **每条必核许可**;CC-BY 必须在 `public/resources/runtime/audio/ATTRIBUTION.md` 署名
  (sfx_jingju_luogu 即 CC-BY 4.0 先例)。
- **ogg 必转 wav/mp3**——Safari 不播 ogg。

## 入库三件套

1. 文件进 `public/resources/runtime/audio/`
2. `public/assets/data/audio_config.json` 的 sfx 登记
3. `ATTRIBUTION.md` 记出处与许可

## 响度对齐

粗对齐用 ffmpeg 改文件:配音 mean≈-11.5dB,音效落其下不压人声。单次播放的动态音量走
运行时 playSfx 的 volume 参数(runtime 域机制),不必为一处调用改素材文件。

## 验证

素材审计 --strict + validate-data。
