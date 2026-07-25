---
target: sprite-atlas-anim-contract
date: 2026-07-24
session: 进游戏加载卡顿排查
---

现象: 契约卡说动画产物只有 `atlas.png` + `anim.json`,实际运行时还要一张法线图——原先靠 `spriteNormalAtlas.ts` 在 `scene:ready` 里从 alpha 现算(EDT+高斯),茶馆实测同步阻塞主线程 9624ms(进度条画不出 100%、卡在 98%);现已改为离线烘焙产物 `<图集名>.normal.png`,运行时只做同步缓存读、取不到走 shader 平面法线兜底,同一场景 scene:ready 降到 6.4ms。
证据: `tools/animation_pipeline/bake_normal_atlas.py`(新增,`./dev.sh bake-normals`;`--downscale 1` 与 `character_lighting_lab/pipeline.py#stage_character` 逐像素零差异已验);运行时改动见 `src/rendering/spriteNormalAtlas.ts` + Game.ts 三个挂滤镜调用点;已产出 68 张(46 图集 + 22 热点展示图),默认 1/16 降采样共 640KB、烘完 2.7s。
建议: 契约卡的"动画产物"补上 `<图集名>.normal.png` 与"新增/重导图集后必须跑 bake-normals"这一步;热点 `displayImage.image` 同样需要按 1×1 烘,是同一约定的第二类消费方。
