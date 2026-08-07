---
id: sprite-atlas-anim-contract
title: 动画产物契约(atlas.png + anim.json + normal.png)
domain: asset-pipeline
type: mechanism
summary: 一切动画素材的产出格式硬契约:0基帧、一角色一图集均匀网格、底中脚锚、每边≤2048、离线法线图、animFile 存完整 URL、人工字段并回
status: active
authority:
  - src/rendering/SpriteEntity.ts
  - src/rendering/spriteNormalAtlas.ts
  - src/core/AssetManager.ts#SAFE_MAX_TEXTURE_SIZE
  - tools/video_to_atlas/atlas_core.py#PRESERVED_STATE_FIELDS
  - tools/animation_pipeline/bake_normal_atlas.py
  - public/resources/runtime/animation
triggers:
  paths: ["public/resources/runtime/animation/**", "tools/video_to_atlas/**", "tools/animation_pipeline/**"]
  topics: [anim.json, atlas, 图集, 精灵动画, 锚点, 法线烘焙, normalBake]
  tasks: [产出动画, 重打图集, 改动画格式, 加人工动画字段]
verified_by:
  - tools/editor/tests/test_anim_editor_save_fidelity.py
  - tools/editor/tests/test_anim_reexport_preserves_manual_fields.py
last_governed: 2026-08-05
---

## 是什么(一句话)

游戏能加载的动画素材只有一种形状:`public/resources/runtime/animation/<id>/` 下的
`atlas.png` + `anim.json`(+ 离线烘焙的 `<图集名>.normal.png`、可选 `atlas.meta.json` 记产线
来源);任何素材管线的终点都是它。

## 权威源(读代码从哪进)

运行时消费方 `src/rendering/SpriteEntity.ts`(网格/锚点/播放模型)与 `spriteNormalAtlas.ts`
(法线读取);导出实现 `tools/video_to_atlas/atlas_core.py`(动画产线只 import 复用它);
法线烘焙 `tools/animation_pipeline/bake_normal_atlas.py`。

## 硬契约(违反即 bug)

- **`states[*].frames` 必须 0 基**:运行时直接 `col=idx%cols, row=idx//cols` 且按同一 idx 取
  `atlasFrames`,从不减基准;anim.json 没有 frameIndexBase("帧编号从 1 开始"是已移除的
  footgun,会整体错位丢首帧)。
- **一角色一图集,所有 state 共享均匀网格**;帧多→单帧精灵小,是显式权衡(想大就减帧)。
  单帧静态包(1×1 图集 + 单 `idle` state)是本契约的合法特例,专有约束见
  [单帧静态动画包](static-single-frame-bundle.md)——它只写 `worldHeight`、紧裁到脚。
- **锚点 = anchor(0.5,1) 底中,即脚**:实体的 (x,y) 是精灵**脚底**世界坐标,不是中心。按中心
  锚减半个身高摆位会让全体角色漂高半身位。
- **贴图每边 ≤2048**:`AssetManager` 的 `SAFE_MAX_TEXTURE_SIZE` 超限拒载;多帧用网格摊平,
  不是加大单边。
- **`npc.animFile` 存完整 manifest URL** `/resources/runtime/animation/<id>/anim.json`,不是裸
  id;解析 id 先剥前缀(编辑器 `_anim_bundle_id_from_ref`)。
- **法线图必须离线烘焙**:新增/重导图集后跑 `./dev.sh bake-normals` 产 `<图集名>.normal.png`;
  运行时只做同步缓存读、取不到走 shader 平面法线兜底。**禁止改回运行时现算**——曾在
  `scene:ready` 里从 alpha 现算(EDT+高斯),单场景同步阻塞主线程 9.6s。热点
  `displayImage.image` 是同一约定的第二类消费方(按 1×1 烘)。
- **人工字段必须扛得住重导出**:导出器"从零拼 dict"整份覆盖 anim.json,人手填的值靠
  `merge_preserved_anim_fields` 并回——per-state 走白名单 `PRESERVED_STATE_FIELDS`
  (`referenceSpeed`/`bubbleAnchor`),顶层走"导出器自产键"黑名单取反(`normalBake` 即此类)。
  **加新人工 per-state 字段必须登记白名单**(漏登记 = 静默丢数据);**加新导出产物顶层键必须
  登记黑名单**(漏登记 = 旧值盖新值,至少看得见)。
- **编辑边界**:states(帧序/帧率/循环/增删/重排)、`referenceSpeed`、`normalBake` 与世界尺寸
  是"廉价参数",主编辑器动画面板可格式保真写回;**改图集像素布局(cols/rows/cell/atlasFrames/
  重抠拼帧)必须回产线重导**,这些字段在主面板只读。

## 已知坑

- `normalBake.downscale` 别调回 1/16:每角色约 13×12 的法线会让帧间量化跳变、游戏里着色闪烁;
  缺省 1/4(约 54×51)实测不闪。
- 播放头参数(`speed`/`reverse`/`holdFrame`/`thenState`/`startFrame`)属 **action 与 NpcDef 层**,
  不是 anim.json 层;anim.json 只声明 `referenceSpeed` 这个步速匹配基准(留空即不参与)。
- 保存 anim.json 须保留未知键与键序(深拷贝原包、只施加差异),否则丢 `notes` 等旁注字段。
- `video_to_atlas/gui.py`、`project_model.py` 是已删除的旧实现,现役 = `workspace_model.Workspace`
  + `main_window.py`;照旧文件名找入口会扑空。

## 怎么验证

`test_anim_editor_save_fidelity.py`(无改动保存逐键逐值一致)+
`test_anim_reexport_preserves_manual_fields.py`(重导出不抹人工字段);产完在
[动画预览工具](anim-preview-tool.md) 里与游戏一致渲染目验。
