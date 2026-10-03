偏差：scene-onenter-reveal-timing 仍未描述场景可选 loadingTransition 及独立 DOM 揭幕层，当前实现已支持四种经典效果。
证据：src/data/loadingTransitions.json、src/ui/LoadingSurface.ts、src/ui/LoadingReveal.ts、Game.revealLoadingScene；场景编辑器默认省略字段，每次揭幕随机一次，动画完成后才交还 Loading 所有权。
建议：补齐新配置、画布滤镜/幕布蒙版的取消与销毁清理，以及原金色进度条在逻辑画布中的定位契约；实机证据见 artifact/Reviews/loading-transitions-20261003。
