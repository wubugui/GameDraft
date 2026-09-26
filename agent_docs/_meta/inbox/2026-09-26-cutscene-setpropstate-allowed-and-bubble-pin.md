---
target: content-expression-channels
date: 2026-09-26
session: 跑马梁风口过场熄火时机 / 远处喊话气泡
---

现象: 卡上说过场白名单/存档豁免"制作人未裁定前别改";本次制作人拍板放行 setPropState 进过场(风吹灭火把要落在起风那一拍),并给 setPropState 加了 onlyIfBurning、给 showSpeechBubble(AndWait) 加了 pinOnScreen(说话人在画面外时气泡贴屏幕边)。
证据: src/data/cutscene_action_allowlist.json + tools/editor/validator.py _CUTSCENE_STAGING_SAVE_ACTIONS 加 setPropState;过场 跑马梁_纸钱引路;narrative wrapper_跑马梁_风火引路「有人喊」;EmoteBubbleManager.pinBubbleInsideView。
建议: content-expression-channels 与 action-registration-registry-surfaces 两卡记下这次裁定;过场里"拆两段"不是熄火的替代——cutscene:end 会 clearGust,把正在刮的阵风掐掉。
