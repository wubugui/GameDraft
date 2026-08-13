---
target: save-restore-contracts
date: 2026-08-12
session: 玩家站位进档 + 新增瞬移 Action
---

现象: 存档从来不记玩家站位（SaveManager 只取 sceneManager.currentSceneId，
SceneManager.serialize 的 sceneMemory 是**场景实体**的覆盖桶、玩家不是场景实体），
读档一律回出生点；同时 action 面缺"瞬移"这一档（moveEntityTo 走过去 / jumpEntityTo 跳过去，
setSceneEntityPosition 与 persistNpcAt 都只认 npc/hotspot，够不着玩家）。
证据: 本轮改动 —— ①`Game.collectSaveData` 新增顶层 `player:{x,y,facing}` 桶，
`distributeSaveData` 里 `restorePlayerPose` 只**登记待落位**（就地写 x/y 必被随后的场景重载
盖掉），由 `reloadScene` 透传给 `loadScene` 的第三参数落位——那个参数名叫 `cameraPosition`
但**同时是玩家落点覆盖**（changeScene 的 cameraX/cameraY 走的也是它），落点在 onEnter 之前，
开场演出看到的就已经是存档站位；朝向不受装载影响故就地设。旧档无 player 桶 = 回落出生点，
故未升 SAVE_VERSION。②新增 `teleportEntityTo`（四件套齐 + 进过场白名单 + ENTITY_REF_PARAMS），
一帧到位、不切动画、**不碰朝向**（要转身接 faceEntity），并在"镜头此刻正锚在该实体上"时
补一次 camera.snapTo（判据见 Game.snapCameraToActorIfFollowed：显式 cameraFollowActor 目标
只认它本人；无显式目标时只有玩家算默认锚点且只在 Exploring/ActionSequence 成立——过场态
无目标时镜头归 cameraMove，抢过来会打乱运镜）。真机验：同场景/跨场景读档均落回存档站位与朝向、
抹掉 player 桶的旧档回落出生点、瞬移时镜头无滑行、镜头跟别人时瞬移玩家不动镜头。
建议: 卡里"瞬态不入档"那条旁补一句「**玩家站位/朝向入档**，单列 `player` 桶，落位靠
loadScene 的位置覆盖参数（那个参数不只管镜头）」；另 entity-move-facing 卡可补一句
「位移三档：move 走 / jump 跳 / teleport 瞬移，三者缺省都不碰朝向」。
