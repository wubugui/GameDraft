---
id: ambient-fx-production
title: 环境动效素材配方(热气/灯光/窗帘/呼吸人物)
domain: asset-pipeline
type: recipe
summary: LibTV 出黑底/洋红底静图→fx_build.py 程序化循环→网格图集→装饰 NPC 放置(renderRaw/不可交互/脚锚)
status: active
authority:
  - tools/animation_pipeline/ambient_fx/fx_build.py
  - src/data/types.ts#renderRaw
  - public/resources/runtime/animation
triggers:
  paths: ["tools/animation_pipeline/ambient_fx/**"]
  topics: [环境动效, 热气, 灯笼, 窗帘, 装饰NPC, ambient fx]
  tasks: [给场景加动效, 做氛围动画素材]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-04,dev_teahouse_alive 场景落地(3 热气 + 2 灯笼暖光 +
1 窗帘 + 5 呼吸茶客),fx_* bundle 均在 `public/resources/runtime/animation/`。

适用:场景要"活"但不值得做角色动画的氛围元素。源图与脚本持久化在
`tools/animation_pipeline/ambient_fx/`(fx_build.py + stills/),用 `.tools/venv` 跑。

## 步骤

1. **LibTV 出静图**:热气/灯笼 glow 画在**纯黑底**、窗帘画在**纯洋红底**(便于抠)。
   模型选型:Seedream 出中式贴图(最低 2K);**平滑无纹理的径向 glow 必须用
   nebula-ultra(Lib Navo Pro)**——Seedream 会把 glow 画成螺旋纹。CLI 坑见
   [LibTV 出图配方](libtv-image-generation.md)。
2. **抠图**:黑底 = 亮度转 alpha(`lum_to_rgba`);洋红底窗帘 = `matting.matte_rgba` fusion
   (洋红**渐变**底色键去不掉紫灰雾)+ 去洋红溢色(`min(R,B)-G>阈值` 时把 R、B 压向 G)
   + 压暗(≈0.58)匹配暗场景。
3. **程序化循环**:全部用相位 0..2π 参数化 → 天然无缝循环。热气 = 逐行正弦摆动(底钉顶摆);
   窗帘 = 钟摆式(顶钉底摆);灯 = alpha 闪烁。烤入人物的呼吸循环见
   [烤入背景人物活化](../methods/baked-figure-activation.md)(只向上鼓,禁对称 sin)。
4. **打图集**:PNG 每边 ≤2048,多帧用网格(cols×cellW≤2048);anim.json 契约见
   [动画产物契约](../mechanisms/sprite-atlas-anim-contract.md)。
5. **放场景(装饰 NPC 范式)**:NpcDef 只给 animFile + `interactionRange:0` +
   `castShadow:false` + 无 dialogueGraphId → 自动循环 idle、不可交互、参与 Y 排序。
   贴图取自已烤光照的背景时必须 `renderRaw:true`(不再吃逐 entity 光照/深度遮挡/像素密度
   滤镜,否则色调与背景不符、露方框接缝;仍受全局场景色彩滤镜)。锚点 = 底中脚,
   (x,y) 是脚底世界坐标。

## 验证

素材审计 --strict + validate-data;真场景逐个 zoom 目验(循环无缝、色调融入、无接缝方框)。

坑:新建测试场景要出现在 dev 场景面板,必须在 `public/assets/data/map_config.json`
加节点——面板读 map_config,不扫 scenes 文件夹。headless 下的截图验证配方见
runtime 域 `headless-visual-verification` recipe。
