---
target: cutscene-step-semantics
date: 2026-07-17
session: 开场过场拆分+收场运镜
---

现象: 两个卡内未载的镜头语义坑。①世界≤视口时(如茶馆700×525、zoom1 全景)相机中心被钉死在世界中心,cameraMove 全程 no-op——编排"运镜"必须先 cameraZoom 收小视口再 move,顺序反了 move 按大视口夹紧照样不动。②restoreState:false + skip 原语义缺口:abortCutsceneOps 定格补间中值、未执行步整体丢弃,跳过者永久带走半途镜头(zoom 卡 1.4),探索态只跟位置不自愈缩放。
证据: ②已修——CutsceneManager 新增 applyFinalCameraPoseForSkip(跳过 restoreState:false 过场时相机落到 steps 最后 cameraMove/cameraZoom 目标值,先 zoom 后 snap 保证夹紧正确);真机验证 A中途ESC→(416,312,1.8)=自然终姿、双ESC→(350,263,1)=探索基线零残值。①为编排铁律候选。
建议: 卡补三条:"世界≤视口时 cameraMove 无效,运镜先 zoom 后 move";"restoreState:false 被跳过时引擎快进相机到编排终姿(与自然播完一致),编排者可依赖此语义";"cameraZoom scale 缺省/≤0 = 恢复场景配置基线缩放(scene.camera.zoom),内容侧勿写基线字面量"(L2 2026-07-17:Camera.sceneBaseZoom + Game.cameraSetter 记录 + CutsceneManager 两消费点 + timeline_editor seed/hint/护栏测试锚点同步)。
