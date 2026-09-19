---
target: per-site-audio-volume
date: 2026-09-19
session: leifu-skill
---

现象: 卡只讲素材级/逐处音量,没提通道音量还有第二层——`setVolume` 写的是**玩家偏好**(进存档),演出临时压低必须走新的闪避层 `pushAudioDuck`,否则等于替玩家改了设置页的档位。
证据: `src/systems/AudioManager.ts#pushAudioDuck` / `serialize()`;测试 `src/systems/AudioManagerDuck.test.ts`。
建议: 本卡补一节「偏好 × 闪避两层」,并注明闪避每层自带到期兜底。
