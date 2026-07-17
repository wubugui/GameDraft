偏差1: ProjectModel.undo_stack 是死栈(push_edit 全库零调用者),Edit→Undo 菜单原挂空;2026-07-18 起菜单转发当前编辑器鸭子钩子 editor_undo/editor_redo(场景编辑器已接,快照命令栈见 tools/editor/editors/scene_undo.py)。
偏差2: 主编辑器 07-14 审查记忆索引写"2P0+19P1 未修",但 artifact/Reviews/主编辑器全面审查-2026-07-14.md 自身标注全部修复+代码抽验吻合——记忆口径过期,以文档+代码为准。
偏差3: Game.applyHotspotRuntimeFieldNow 是逐字段特化、无 NPC 路径那样的通用 def 写入,新增热点运行时字段必须在分支里自写 def(transform 落地时踩到,已修);runtime-command-channel 卡的"隐藏 pane 轮询节流"在本轮再次实测成立,页内直驱(window.__game+actionExecutor.executeAwait/setSceneEntityFieldFromAction)是最稳验收路径。
