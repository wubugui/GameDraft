---
id: static-single-frame-bundle
title: 单帧静态动画包(一张图 → 能当 NPC 用)
domain: asset-pipeline
type: mechanism
summary: 一张透明 PNG 打成 1 格图集 + 单 idle state 的动画包；紧裁使格底=脚、worldHeight=角色本体身高；占位标记与身高标定是换正式包不跳尺寸的唯一凭据
status: active
authority:
  - tools/animation_pipeline/workbench_stages.py#pack_static_single_frame
  - tools/animation_pipeline/workbench_stages.py#write_h_static_bundle_stage
  - tools/animation_pipeline/static_bundle_batch.py
  - tools/animation_pipeline/placeholder_audit.py
  - tools/anim_preview/workspaceStore.mjs#H_STATIC_BUNDLE
triggers:
  paths: ["tools/animation_pipeline/**", "public/resources/runtime/animation/**"]
  topics: [占位包, 单帧动画包, 静态角色, H_STATIC_BUNDLE, placeholder]
  tasks: [做占位角色, 把展示图变成NPC, 静态角色出包, 盘点占位]
verified_by:
  - tools/animation_pipeline/tests/test_workbench_stages.py
last_governed: 2026-08-06
---

## 是什么(一句话)

把**一张已抠图的透明 PNG** 打成合法动画包(`atlas.png` 1 格 + `anim.json` 单 `idle` state),
让"还没动画的角色"和"永远不会动的群像"都能当 NPC 摆进场景——占位先行、剧情照编,
正式动画包上线时换掉同名目录即可,场景数据一处不用改。

## 权威源(读代码从哪进)

- 打包 `workbench_stages.py#pack_static_single_frame`;落 staging `write_h_static_bundle_stage`;
  CLI 子命令 `h-static-bundle`。
- 批产/发布 `static_bundle_batch.py`(`stage` → 目验 → `publish`,发布带备份与哈希核验)。
- 盘点 `placeholder_audit.py`(`./dev.sh placeholder-audit`)。
- 工作台节点 `H_STATIC_BUNDLE`(deps: accepted C,与 `H` 写同一个 bundle 目录)。

## 硬契约(违反即 bug)

- **必须紧裁**:运行时锚点是格底中点,留白 = 角色整体浮起来。实测码头人群源图底部 17%
  透明留白 → 直接换过去下沉 68 个世界单位。降采样后要**再紧裁一次**(抗锯齿边会掉到
  alpha 阈值以下),否则"内容高 == 格高"这个不变量不精确成立。
- **只写 `worldHeight`,不写 `worldWidth`**:格宽是像素取整的结果,写死两维会让世界长宽比
  与格长宽比对不上,运行时引入**非等比缩放**。宽由 `resolveAnimationSet.ts` 按格比推。
- **`worldHeight` = 角色本体世界身高**(成年人≈150,玩家 150),不是"格子的世界高"。
  正式动画包的格里含跳跃/挥臂留白,同填 150 时本体反而更矮——**换正式包那天 R 阶段的
  worldSize 必须让本体身高对齐 `atlas.meta.json.authoredBodyHeight`**,不是照抄 worldHeight。
- **分辨率按出货密度定标**(`SHIPPED_TEXELS_PER_WORLD = 1.4`,即 150 身高 → 格高约 210)。
  更高的分辨率会被 `EntityPixelDensityMatch` 的低通糊掉,纯浪费显存与磁盘。只缩不放。
- **state 名钦定 `idle`**:`Npc.loadSprite` 与 `CutsceneRenderer` 的初始态解析都优先 `idle`,
  换名就退化成"取第一个 key"。
- **占位标记只进 `atlas.meta.json`(`placeholder: true`),不进 `anim.json`**:anim.json 加顶层键
  要同步登记导出器黑名单(见[动画产物契约](sprite-atlas-anim-contract.md)),否则重导出旧值盖新值。
- 适配器**只写 staging、拒绝 `public/resources/runtime`**;发布是显式的 `publish` 动作。

## 已知坑

- H 的打包器有「每帧恰好被引用一次」不变量,**多个 state 指同一帧过不了 H**。静态包的别名
  state 走独立打包函数(运行时完全合法——出货包 `npc_popo_anim` 的 `stand` 就是 idle 帧别名),
  别去松 H 那条约束。
- 内容 bbox 的中线未必是双脚中线(伸手/扛担/拖影都会拉偏)。用 `--foot-anchor-x` 显式补边,
  别事后在场景里挪 x——挪 x 会连碰撞多边形与交互半径一起挪歪。
- `atlas.meta.json` 的 `sourceCanvas` + `sourceContentBox` 是**热点展示图 → NPC 换算的唯一依据**
  (见 [entity-refactor-engine](../../content/mechanisms/entity-refactor-engine.md) 的换种类 op),
  少了它只能按整幅矩形估。
- 早于本机制的手搓占位包(`packMode: static_bundle_20260806`,如 12 个 `npc_funeral_*`)没有
  `authoredBodyHeight`,但它们同样紧裁,`anim.json.worldHeight` 即本体身高;盘点工具已回落读它。
  **别为了统一格式去重打这些已上线包**——那是换源,违反源一致性。

## 怎么验证

- `.tools/venv/bin/python -m pytest tools/animation_pipeline/tests/ -q`;
- `./dev.sh bake-normals <bundleId>` 后跑素材审计 + `validate-data`;
- **真机**:随便挑一个包 `setEntityField(animFile)` 换到某 NPC 上,看它站得住、大小对、吃光照
  (2026-08-06 实测:白无常占位包在码头白天渲染正常,1 帧、身高 195、脚踩地)。
- `./dev.sh placeholder-audit` 看还欠哪些资源、被谁用着。
