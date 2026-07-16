---
id: parallax-layer-assembly
title: 过场视差分层素材装配配方
domain: asset-pipeline
type: recipe
summary: LibTV 分层图→归一 1672×941→zIndex 层序→装配 parallax_scenes.json;方图先裁 16:9 带再缩
status: active
authority:
  - public/assets/data/parallax_scenes.json
  - tools/parallax_editor/parallaxPlugin.ts
  - public/resources/runtime/images/parallax
triggers:
  paths: ["public/assets/data/parallax_scenes.json", "public/resources/runtime/images/parallax/**", "tools/parallax_editor/**"]
  topics: [视差, parallax, 分层, 过场插画]
  tasks: [做视差过场素材, 装配分层场景]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-05,神仙岭 11 场景全部装配入库;素材审计 --strict 与
validate-data 全过,parallax 编辑器逐场景 WYSIWYG 还原原图。

适用:把一张过场插画拆成多层做纵深视差。只对**人物与纵深分明**的帧做;近身特写/纯风景留单图。

## 步骤

1. **LibTV 下载分层**:`libtv node list` 拿 id → 逐个 `libtv node <id>` 取详情
   (**用 Python 循环,bash 循环会静默丢输出**)。分层节点是 `image_generate`:
   `data.url[0]`=输出图、`params.prompt`=这层是什么、`params.imageList[].label`=来源插画,据此归组。
   CLI 环境坑见 [LibTV 出图配方](libtv-image-generation.md)。
2. **抠图**:走 [纯色底色键配方](colorkey-matting.md)。
3. **归一到 1672×941**(cover 对齐):16:9 图直接缩;**2048² 方图先裁中间 16:9 带
   (y∈[448,1600])再缩**——方图是 16:9 letterbox 进方画布,直接缩会带上下黑带。
4. **层序**:按内容启发式 zIndex(天空/背景板 0 < 山 10 < 近景/次要 18~24 < 主体 26~30 <
   纯特效 36);视差深度缺省 `depth=z/34`。无背景板的场景用原图当不透明底
   (坑:大幅漂移时原图里的人物会露出淡重影,漂移轻则可接受)。
5. **落盘**:层图进 `public/resources/runtime/images/parallax/<scene>/<roleid>.png`;场景条目
   写 `public/assets/data/parallax_scenes.json`(2 空格缩进 + 末尾换行,与编辑器写盘格式一致,
   否则编辑器一保存就整文件 diff)。

## 验证

素材审计 --strict + validate-data + parallax 编辑器(`npm run dev:parallax-editor`,
`?scene=<id>` 深链)逐场景对照原图看对齐/层序/无键色残留。
**编辑器 play 受隐藏页 rAF 节流,验轨迹用时间轴 scrub,别信 play 的速度。**

## 关联

parallax_scenes.json 的字段语义、相机烘焙、运行时 present 命令归 runtime/editor-tools 域;
本卡只管素材侧。
