---
id: breathing-workbench
title: 呼吸工作台(独立桌面应用 · 只改呼吸图的表演参数 · 页内跑同一份模拟 / 着色 / 呼吸声 · 对话图那段原样演 · 出片 · 资产唯一写入者)
domain: editor-tools
type: mechanism
summary: 呼吸图资产 assets/data/breathing/<id>.json 唯一的作者面与写入者,只许改 params 与 label(size / layers / fields / rig 是离线拆层产物,保存时逐值比对、改了拒存);页内预览打包运行时 BreathingPerformance / breathingParams / breathingOverlays / breathingUniforms / breathSynth 本体,画面经工作台 RHI 接入层用游戏同一个 WebGPU 渲染器 + 游戏的呼吸图 Mesh(breathingShade.wgsl,层贴图按游戏口径预乘;没有 GLSL 孪生),与游戏同输入逐字节相同(真 GPU 对照 + 空后端命令对照),页面里没有第二份模拟 / 着色;「用在哪」从对话图抽出用到这张图的那一段线性时间轴原样演(渐弱等停住、猛吸、收掉);图 + 按钮 + 曲线钉在顶上、参数在下面滚;参数文本可复制 / 套用;推给游戏(拖参数时跑着的游戏里跟着变)/ 导出到游戏(写盘)命名照定案;出片 = 同一舞台逐帧画进成品尺寸的离屏渲染纹理、异步读回(自上而下)→ 循环 GIF + 接触表 / 剧情 MP4
status: active
authority:
  - tools/breathing_workbench/store.py
  - tools/breathing_workbench/serve.py
  - tools/breathing_workbench/story.py
  - tools/breathing_workbench/render.py
  - tools/breathing_workbench/bundle.py
  - tools/breathing_workbench/game_link.py
  - tools/breathing_workbench/viewer/app.js
  - tools/breathing_workbench/gpu/breathingView.ts
  - tools/workbench_rhi/offscreenReadback.ts
  - tools/workbench_rhi/README.md
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
  - tools/breathing_workbench/tests/test_parity.py
  - tools/breathing_workbench/gpu/breathingView.test.ts
  - tools/breathing_workbench/viewer/tests/selftest.js
last_governed: 2026-09-24
---

## 是什么(一句话)

给制作人调「盖脸纸那类呼吸图」的桌面工具:所有表演参数实时调、立刻看;能按对话图里那一段剧情原样走一遍;
能推给正在跑的游戏看;满意了导出到游戏;还能按这组参数出循环 GIF 与剧情 MP4。

起:`sh scripts/py.sh -m tools.breathing_workbench`(主编辑器「工具 → 呼吸工作台…」、开发控制台同名按钮同一条)。

## 结构(与燃烧工作台同一套壳)

- 壳 `tools/desktop_shell.py`(临时端口、单实例、三层禁缓存、关窗 / 刷新前问未保存);`--selftest` 读写全指到临时样例工程;`--serve --fixture [dir]` 起样例工程服务(Chrome 自检 / 像素对照用)。宿主拿不到 WebGPU(offscreen QtWebEngine)时画面写明原因、不回落,调参 / 剧情 / 保存 / 推给游戏照常,自检里画面那几条记 SKIP;真 GPU 的 Chrome 里同一份自检不许有 SKIP。
- `store.py`:唯一写盘口(原子写、LF、不排序键、数值写法保真、盘上被别处改过拒写、没改不写、**不新建**)。
- `bundle.py`:经共用的工作台 RHI 接入层(`tools/workbench_rhi`,vite 库模式、打包器自报源清单判新旧、产物不进 git)把运行时模块 + 游戏渲染(engine2d / RHI / `createBreathingOverlayMesh`)+ 接入层的 `workbenchRhi` / `offscreenReadback` + 画面胶水 `gpu/breathingView.ts` 打成一个 ESM;没有任何 GLSL 路由(`/gen/breathingShade.glsl` 已删)。
- `gpu/breathingView.ts`(`BreathingStage`):只用游戏对象拼画面——位移场 `createBreathingFieldTextures`、呼吸图 `createBreathingOverlayMesh`(摆法 `percentLayerRect(屏, 图, 50, 50, 100)`,与 `CutsceneRenderer.showBreathingLayer` 同一个函数)、每帧 `breathingUniforms`;"屏"= 预览画布 CSS 尺寸 / 出片成品尺寸,变了就重建 mesh;拆卸顺序同 `hideLayer`。
- `story.py`:扫 `assets/dialogues/graphs/*.json`,从 `showBreathingOverlay`(breathing = 这张图)那一步顺着 `next` 抽线性时间轴,
  同一个句柄被 `hideOverlayImage` 收掉 / `end` / 分支为止;别的句柄的呼吸图动作不算。
- `render.py`:页面逐帧把舞台画进成品尺寸的离屏渲染纹理、异步读回(接入层 `offscreenReadback`,**自上而下**,最多挂 4 帧)送原始 RGBA,这里原样存帧(不翻)、拼 GIF / 接触表 / MP4(ffmpeg),落 `local/breathing_renders/`。
- `game_link.py`:经 vite 上那对槽推给游戏,探针序号「粘」住;地址发现 / 拉起游戏复用声学台那套。

## 硬契约

- **页面里不许有第二份模拟 / 合成 / 着色组装,也不许有自己的着色器**(`test_bundle.py` 禁词:GLSL / WebGL / WGSL / readPixels;必须调用 `rt.*`)。
- 画面 == 游戏:`gpu/breathingView.test.ts`(空后端逐条 GPU 命令)+ `tests/parity/run.mjs`(真 GPU 逐字节:预览对游戏画布,出片对引擎自己的离屏读法 extract;出片与游戏画布在少数像素差 1 是引擎画布翻转光栅化所致,见 `tools/workbench_rhi/README.md`)。
- **只改 params 与 label**;烘焙产物改了拒存(`store.BAKED_KEYS`)。
- 「推给游戏」= 立即推运行时、带未保存工作态、不写资源;「导出到游戏」= 写资源。别造第三个名字。
- 下拉走 `/vendor/dropdown.js`(QtWebEngine 原生弹窗在高缩放屏上坏)。

## 已知坑

- 剧情播放与出片是逐帧同步推的:等「渐弱走完 / 猛吸结束」要轮询 `perf.isSettled()` / `perf.isGaspDone()`,不能等 Promise。
- 出片开始时**先**置 `S.rendering` 再等服务端 `begin`:2026-09-27 以前反过来,等的那几帧里预览 rAF 按真实时间推这条表演,成片起点随请求快慢漂(实测 0.067 s),同参数两次出片对不上(自检 S17 守着)。
- 迁 RHI 之前(WebGL2 + GLSL 孪生)的出片与游戏不一致:层贴图不预乘上传(`uPremul = 0`),直通 alpha 线性过滤把透明像素里的颜色渗进半透明边(纸 / 胸口 / 垂帘边一圈褐色晕,约 0.5% 像素、最大差 ~60);现在与游戏同一口径(解码期预乘、`uPremul = 1`)。GLSL 与 WGSL 本身在同一口径下只差末位(≤1、≤0.013% 像素)。
- 真工程数据:worktree 里 `public/resources/runtime` 是 junction,`store.media_file` 先按真实路径、再按字面路径判白名单(与 `asset_manifest._public_rel` 同一修法),字面上爬出 `public/` 的一律拒。
- 自检、单测都不许碰真库:`store.PROJECT` / `store.DATA` 重定向;开发控制台对「已有实例在跑」会拒绝再起(测试前先关掉手动起的 `--serve`)。
