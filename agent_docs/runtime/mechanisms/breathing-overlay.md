---
id: breathing-overlay
title: 呼吸图(一张静帧实时在呼吸的叠图 · 离线拆层 + 位移场 · 表演模拟 · 叠图同一套句柄 · 参数实时可改)
domain: runtime
type: mechanism
summary: 盖脸纸那类「一张静帧实时在呼吸」的叠图:资产 = 离线拆好的几层(底图 / 胸口 / 贴脸的纸 / 垂帘)+ 两张 RGBA16F 位移场 + 骨架常数 + 表演参数预设(assets/data/breathing/<id>.json,呼吸工作台唯一写者);运行时一张自建 Mesh + breathingShade.glsl 每帧反查源点重合几层,挂在叠图同一张 images 表、同一套 id 句柄(hideOverlayImage / 过场 cleanup 都收得掉);BreathingPerformance 是唯一的表演模拟(胸口升余弦、纸按吸/呼窗口贴/飞 + 二阶弹簧、纸比胸口晚走延迟缓冲、渐弱 / 假停 / 猛吸冲量解回弹),走游戏时钟吃暂停闸;三个动作 showBreathingOverlay / breathingPerform(wait = 等渐弱走完 / 猛吸结束)/ setBreathingParams(可渐变);参数表唯一真相源 src/data/breathingParams.json(运行时、工作台、主编辑器共用)
status: active
authority:
  - src/systems/breathing/BreathingPerformance.ts
  - src/systems/breathing/breathingParams.ts
  - src/data/breathingParams.json
  - src/systems/breathing/BreathingOverlaySystem.ts
  - src/data/breathingOverlays.ts
  - src/rendering/breathingShade.glsl
  - src/rendering/breathingUniforms.ts
  - src/rendering/breathingOverlayMesh.ts
  - src/audio/breathSynth.ts
  - src/rendering/CutsceneRenderer.ts#showBreathingLayer
  - src/systems/AudioManager.ts#startProceduralBreath
  - src/dev/runtimeBreathingSync.ts
  - src/dev/runtimeBreathingApiPlugin.ts
triggers:
  paths: ["src/systems/breathing/**", "src/data/breathingParams.json", "src/data/breathingOverlays.ts", "src/rendering/breathingShade.glsl", "src/rendering/breathingUniforms.ts", "src/rendering/breathingOverlayMesh.ts", "src/audio/breathSynth.ts", "src/dev/runtimeBreathingSync.ts", "src/dev/runtimeBreathingApiPlugin.ts", "public/assets/data/breathing/**", "public/resources/runtime/images/breathing/**"]
  topics: [呼吸图, 盖脸纸, 纸随呼吸, 胸口起伏, 纸比胸口晚, 渐弱, 假停, 猛吸, 位移场, 反查源点, 呼吸声, showBreathingOverlay, breathingPerform, setBreathingParams]
  tasks: [做呼吸图, 调盖脸纸, 改呼吸节奏, 剧情里改呼吸参数, 接新的呼吸图]
verified_by:
  - src/systems/breathing/BreathingPerformance.test.ts
  - src/systems/breathing/BreathingOverlaySystem.test.ts
  - src/dev/runtimeBreathingSync.test.ts
last_governed: 2026-09-24
---

## 是什么(一句话)

一张静帧(盖脸纸那一幕)在游戏里**实时**呼吸:不是视频、不是帧序列,是把原画离线拆成几层 + 两张位移场,
运行时一段片元着色器按表演模拟的输出每帧把几层重新合出来。节奏、幅度、纸与胸口怎么对上、渐弱、猛吸全是参数,
剧情里还能随时改(可渐变)。

## 资产(`public/assets/data/breathing/<id>.json`,id == 文件名;**呼吸工作台唯一写者**)

| 字段 | 谁产出 | 是什么 |
|---|---|---|
| `layers.base` | 离线拆层 | 底图:会动的部分去掉后补好的背景——**脸永远在这层,永远不动** |
| `layers.body` / `sheet` / `flap` | 离线拆层 | 胸口(外套 + 盘扣)/ 贴脸的整片纸 / 下巴外垂着的纸帘;都可缺 |
| `fields` | 离线拆层 | 两张 RGBA16F 背靠背的 .bin:① 纸面单位位移 xy + 权重(贴脸处 0)② 胸口朝上 / 朝头权重 |
| `rig` | 离线拆层 | 每毫米几像素、垂帘挂点 / 长度、纸帘朝向、灯方向、明暗系数、**位移上限 `limits`** |
| `params` | 呼吸工作台 | 表演参数预设(键见 `src/data/breathingParams.json`) |

媒体放 `public/resources/runtime/images/breathing/<id>/`(DVC 管的那棵)。分层与位移场只对这一张图有效,换图要重烘;
烘焙脚本目前还在 `artifact/FacePaperBreath_20260923/`(fp4_build.py 一套),没有收成正式工具。

## 运行时

- **表演模拟 `BreathingPerformance`(唯一一份,工作台打包的就是它)**:胸口吸气 / 呼气升余弦;纸的驱动在吸气里
  「贴下开始—结束」那段为 −深度、呼气里「飞起开始—结束」为 +深度,两头按「过渡」smoothstep;纸 = 二阶弹簧跟驱动。
  「纸比胸口晚」:源头每 4 ms 记一笔,胸口读「现在 − 胸口延迟」、纸与鼻息读「现在 − 纸延迟」(谁晚谁延迟)。
  渐弱 = 当前这口收浅 → 变浅 → [假停,0 = 没有] → 最后一丝 → 停;猛吸 = 胸口 `1-(1-u)^爆发`、吸力开头最猛,
  驱动大到让纸一定贴死在「纸最多贴下」,**松开那一刻二分出一个速度冲量**,让回弹最高点正好 = 「松开后纸弹起」。
  确定性:同参数、同调用、同 dt 序列逐位相同(抖动用带种子的随机)。
- **参数**:`setParams(patch, rampSec)` 从当前生效值平滑过渡;未知键 / 非数值拒收并返回键名;越界按参数表夹紧。
- **渲染**:`CutsceneRenderer.showBreathingLayer` 按 showPercentImg 同一套百分比布局挂自建 Mesh,登进 **images 表**
  (与叠图同一套 id 句柄)——`hideOverlayImage`、同 id 换层、过场 cleanup 都收得掉;收掉时回调让实例退役(声音停、
  等它的剧情步骤兑现放行)。着色器是 `breathingShade.glsl`(按 BEGIN/END 切片,工作台同一份);每帧 uniform 由
  `breathingUniforms()` 算(工作台同一份)。
- **时间**:`Game.tick` 里 `if (!worldPaused) breathingOverlaySystem.update(dt)`——走游戏时钟、吃暂停闸;
  `breathingPerform` 的 `wait` 也按游戏时钟兑现。
- **声音**:`breathSynth.ts`(噪声过两路带通,响度随鼻息流量)经 `AudioManager.startProceduralBreath` 接到唯一出口
  `Howler.masterGain`、按 sfx 通道混音、登进 liveMixSounds;每次更新顺带预约 0.25 s 后淡出(停更新 = 自己落下去)。

## 动作

| 动作 | 参数 | 语义 |
|---|---|---|
| `showBreathingOverlay` | `id`(句柄)、`breathing`(资产 id)、`xPercent` `yPercent` `widthPercent`、`order?` | 显示,从「出图后第一口深叹」开始;显示出来才兑现 |
| `breathingPerform` | `id`、`act` ∈ breathe / fadeOut / gasp / stopNow / restart、`wait?` | `wait`:fadeOut 等「停住 + |纸比胸口晚| + 真停后多久出字」、gasp 等猛吸结束 |
| `setBreathingParams` | `id`、`params`(参数名 → 数值)、`durationMs?` | 实时改;`durationMs` > 0 平滑过渡 |

收掉用 `hideOverlayImage`(同一个句柄)。三个都是纯表演(PRESENTATION_ONLY),显示 / 表演进 warp 重放静默表;
**不在过场白名单**(与 showOverlayImage 同一待遇)。

## DEV 联动(游戏是预览器)

`/__gamedraft-api/runtime-breathing`(工作台 → 游戏:`{rev, writer, breathing?, probe?}`)/ `-status`(游戏 → 工作台)。
推来的工作态顶替盘上那份,**正在显示的同一张图立刻换上新参数**(拖滑条游戏里跟着变);探针 show / hide / restart /
breathe / fadeOut / gasp / stopNow。撤销覆盖时丢 JSON 缓存,下次显示从盘上重读。

## 硬契约

- **脸必须逐像素不动**:位移只作用在 body / sheet / flap 三层,sheet 的贴脸部分权重 0;静止帧 = 原图。
- **位移场坡度 × 位移 < 约 0.6**:反查源点是不动点迭代(12 次),超了不收敛、画面扯坏;上限写在各图的 `rig.limits`,
  模拟与 uniform 换算都按它夹紧。
- 游戏装载的层贴图 rgb 已被浏览器在解码期 ×alpha(见 pixi-v8-traps),着色器 `uPremul = 1` 先除回去;
  工作台自己上传不预乘 `uPremul = 0`。两边别混。
- 参数表只在 `src/data/breathingParams.json` 维护;名称(label)是给制作人的「参数文本」用的键,**不许重名**(单测守着)。

## 已知坑

- 逐帧同步推进的调用方(工作台出片)不能靠 `fadeOut()` / `gasp()` 返回的 Promise 判"走完了"——微任务要等回到事件循环才跑;
  轮询 `isSettled()` / `isGaspDone()`。
- 贴图与位移场第一次显示时要加载(~11 MB);对话会等显示出来才往下走,黑场里多停一下。
