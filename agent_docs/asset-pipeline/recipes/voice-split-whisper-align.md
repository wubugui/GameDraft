---
id: voice-split-whisper-align
title: 拆配音词级对齐配方
domain: asset-pipeline
type: recipe
summary: 把整段配音按字幕拆条必须用 whisper 词级时间戳定刀位;纯静音检测会被口播偏词骗
status: active
authority:
  - public/assets/data/audio_config.json
  - public/resources/runtime/audio
triggers:
  topics: [配音, 拆音频, whisper, 对齐字幕]
  tasks: [拆配音, 配音对齐字幕]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-02,说书过场配音拆分(faster-whisper,CPU int8,small 模型,
pip 装进会话 venv;ffmpeg silencedetect/volumedetect)。

适用:一整条配音要按字幕节拍切成多个文件。

## 核心结论(为什么不能只用静音检测)

**静音检测会被"实际口播与字幕文本不一致"骗**——配音演员多念/少念词时,按静音窗切出来的
段落与字幕错位(实测 voice_2 多念了一句)。必须拿**词级时间戳**核对文本再定刀位。

## 步骤

1. faster-whisper 转写拿词级时间戳,对照字幕文本找段边界:B 段首词 start 与 A 段末词 end。
2. **刀位 = 该间隙内静音窗的中点**:whisper 的词尾时间常偏早,要和 ffmpeg silencedetect
   的静音窗**取交集**再取中点,别直接用 whisper 端点。
3. 切割与质检的 ffmpeg 坑:
   - `-ss` 必须放 `-i` **之后**(输出侧精确定位;放前面是关键帧粗定位)。
   - 质检音量必须用滤镜链内 `atrim` 裁剪再 `volumedetect`——输出侧 `-ss/-t` 不影响滤镜统计。
4. 干净判据:A 段尾 / B 段头各 0.15s 的 max_volume ≤ -35dB。

## 入库

切好的文件进 `public/resources/runtime/audio/` 并在 `audio_config.json` 登记
(同 [音效外采配方](sfx-external-sourcing.md) 的入库三件套);跑素材审计 + validate-data。
