---
id: breathing-workbench
title: 呼吸工作台(独立桌面应用 · 只改呼吸图的表演参数 · 页内跑同一份模拟 / 着色 / 呼吸声 · 对话图那段原样演 · 出片 · 资产唯一写入者)
domain: editor-tools
type: mechanism
summary: 呼吸图资产 assets/data/breathing/<id>.json 唯一的作者面与写入者,只许改 params 与 label(size / layers / fields / rig 是离线拆层产物,保存时逐值比对、改了拒存);页内预览打包运行时 BreathingPerformance / breathingParams / breathingOverlays / breathingUniforms / breathSynth 本体、着色拼 breathingShade.glsl,页面里没有第二份模拟;「用在哪」从对话图抽出用到这张图的那一段线性时间轴原样演(渐弱等停住、猛吸、收掉);图 + 按钮 + 曲线钉在顶上、参数在下面滚;参数文本可复制 / 套用;推给游戏(拖参数时跑着的游戏里跟着变)/ 导出到游戏(写盘)命名照定案;出片用同一份代码逐帧读回 → 循环 GIF + 接触表 / 剧情 MP4
status: active
authority:
  - tools/breathing_workbench/store.py
  - tools/breathing_workbench/serve.py
  - tools/breathing_workbench/story.py
  - tools/breathing_workbench/render.py
  - tools/breathing_workbench/bundle.py
  - tools/breathing_workbench/game_link.py
  - tools/breathing_workbench/viewer/app.js
  - src/dev/runtimeBreathingSync.ts
  - src/dev/runtimeBreathingApiPlugin.ts
triggers:
  paths: ["tools/breathing_workbench/**", "public/assets/data/breathing/**", "src/data/breathingParams.json", "src/dev/runtimeBreathingSync.ts", "src/dev/runtimeBreathingApiPlugin.ts"]
  topics: [呼吸工作台, 呼吸图, 盖脸纸, 调呼吸参数, 参数文本, 出片, 推给游戏, 导出到游戏]
  tasks: [调盖脸纸呼吸, 改呼吸图参数, 出呼吸动画, 改呼吸工作台]
verified_by:
  - tools/breathing_workbench/tests/test_store.py
  - tools/breathing_workbench/tests/test_story.py
  - tools/breathing_workbench/tests/test_serve.py
  - tools/breathing_workbench/tests/test_bundle.py
  - tools/breathing_workbench/tests/test_selftest.py
  - tools/breathing_workbench/viewer/tests/selftest.js
last_governed: 2026-09-24
---

## 是什么(一句话)

给制作人调「盖脸纸那类呼吸图」的桌面工具:所有表演参数实时调、立刻看;能按对话图里那一段剧情原样走一遍;
能推给正在跑的游戏看;满意了导出到游戏;还能按这组参数出循环 GIF 与剧情 MP4。

起:`sh scripts/py.sh -m tools.breathing_workbench`(主编辑器「工具 → 呼吸工作台…」、开发控制台同名按钮同一条)。

## 结构(与燃烧工作台同一套壳)

- 壳 `tools/desktop_shell.py`(临时端口、单实例、三层禁缓存、关窗 / 刷新前问未保存);`--selftest` 读写全指到临时样例工程。
- `store.py`:唯一写盘口(原子写、LF、不排序键、数值写法保真、盘上被别处改过拒写、没改不写、**不新建**)。
- `bundle.py`:rolldown 把运行时模块打成 ESM(缓存戳顺着值 import 扫整棵依赖树);`/gen/breathingShade.glsl` 给原文。
- `story.py`:扫 `assets/dialogues/graphs/*.json`,从 `showBreathingOverlay`(breathing = 这张图)那一步顺着 `next` 抽线性时间轴,
  同一个句柄被 `hideOverlayImage` 收掉 / `end` / 分支为止;别的句柄的呼吸图动作不算。
- `render.py`:页面逐帧 readPixels 送原始 RGBA,这里翻正存帧、拼 GIF / 接触表 / MP4(ffmpeg),落 `local/breathing_renders/`。
- `game_link.py`:经 vite 上那对槽推给游戏,探针序号「粘」住;地址发现 / 拉起游戏复用声学台那套。

## 硬契约

- **页面里不许有第二份模拟 / 合成 / 着色组装**(`test_bundle.py` 禁词 + 必须调用 `rt.*`)。
- **只改 params 与 label**;烘焙产物改了拒存(`store.BAKED_KEYS`)。
- 「推给游戏」= 立即推运行时、带未保存工作态、不写资源;「导出到游戏」= 写资源。别造第三个名字。
- 下拉走 `/vendor/dropdown.js`(QtWebEngine 原生弹窗在高缩放屏上坏)。

## 已知坑

- 剧情播放与出片是逐帧同步推的:等「渐弱走完 / 猛吸结束」要轮询 `perf.isSettled()` / `perf.isGaspDone()`,不能等 Promise。
- 自检、单测都不许碰真库:`store.PROJECT` / `store.DATA` 重定向;开发控制台对「已有实例在跑」会拒绝再起(测试前先关掉手动起的 `--serve`)。
