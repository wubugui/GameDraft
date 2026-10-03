偏差：runtime/mechanisms/detached-performance-session.md、scene-onenter-reveal-timing.md 仍以 SceneTransition 和场景黑幕描述加载边界。
现实：本分支改为 GameState.Loading 独占控制、SceneManager 串行事务、LoadingSurface 全视口遮幕；资源与 GPU 首帧就绪后揭幕，入场效果结束再交接，失败恢复与读档也共用此边界。
建议：收编时以 src/core/Game.ts、GameStateController.ts、src/systems/SceneManager.ts 和 src/ui/LoadingSurface.ts 为准，补齐请求取消、动作 owner 与资源驻留契约；验证证据见 artifact/Reviews/loading-iteration-20261003/。
