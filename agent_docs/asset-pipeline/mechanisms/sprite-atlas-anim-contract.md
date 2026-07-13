---
id: sprite-atlas-anim-contract
title: 动画产物契约(atlas.png + anim.json)
domain: asset-pipeline
type: mechanism
summary: 一切动画素材的产出格式硬契约:0基帧、一角色一图集均匀网格、底中脚锚、每边≤2048、animFile 存完整 URL、编辑边界
status: active
authority:
  - src/rendering/SpriteEntity.ts
  - src/core/AssetManager.ts#SAFE_MAX_TEXTURE_SIZE
  - tools/video_to_atlas/atlas_core.py
  - public/resources/runtime/animation
triggers:
  paths: ["public/resources/runtime/animation/**", "tools/video_to_atlas/**", "tools/animation_pipeline/**"]
  topics: [anim.json, atlas, 图集, 精灵动画, 锚点]
  tasks: [产出动画, 重打图集, 改动画格式]
verified_by:
  - tools/editor/tests/test_anim_editor_save_fidelity.py
last_governed: 2026-07-11
---

## 是什么(一句话)

游戏能加载的动画素材只有一种形状:`public/resources/runtime/animation/<id>/` 下的
`atlas.png` + `anim.json`(+可选 `atlas.meta.json` 记录产线来源);任何素材管线的终点都是它。

## 权威源(读代码从哪进)

运行时消费方 `src/rendering/SpriteEntity.ts`(网格/锚点/播放模型);导出实现
`tools/video_to_atlas/atlas_core.py`(动画产线 `tools/animation_pipeline` 只 import 复用它)。

## 硬契约(违反即 bug)

- **`states[*].frames` 必须 0 基**:运行时直接 `col=idx%cols, row=idx//cols` 且按同一 idx 取
  `atlasFrames`,从不减基准;anim.json 没有 frameIndexBase 字段("帧编号从 1 开始"是已移除的 footgun,会整体错位丢首帧)。
- **一角色一图集,所有 state 共享均匀网格**;帧多→单帧精灵小,是显式权衡(想大就减帧)。
- **锚点 = anchor(0.5,1) 底中,即脚**:实体的 (x,y) 是精灵**脚底**世界坐标,不是中心。
  摆位按中心锚减半个身高会让全体角色漂高半身位。
- **贴图每边 ≤2048**:`AssetManager` 的 `SAFE_MAX_TEXTURE_SIZE` 超限拒载;多帧用网格摊平,不是加大单边。
- **`npc.animFile` 存完整 manifest URL** `/resources/runtime/animation/<id>/anim.json`,不是裸 id;
  解析 id 先剥前缀(编辑器 `_anim_bundle_id_from_ref`)。
- **编辑边界**:states(帧序/帧率/循环/增删/重排)与世界尺寸是"廉价参数",主编辑器动画面板可直接
  格式保真写回;**改图集像素布局(cols/rows/cell/atlasFrames/重抠拼帧)必须回产线重导**,这些字段在主面板只读。

## 已知坑

- `video_to_atlas/gui.py`、`video_to_atlas/project_model.py` 是已删除的旧实现;现役 = `workspace_model.Workspace` + `main_window.py`。
- 保存 anim.json 须保留未知键与键序(深拷贝原包、只施加差异),否则丢 `notes` 等旁注字段。

## 怎么验证

`tools/editor/tests/test_anim_editor_save_fidelity.py`(无改动保存逐键逐值一致);产完在
[动画预览工具](anim-preview-tool.md) 里与游戏一致渲染目验。
