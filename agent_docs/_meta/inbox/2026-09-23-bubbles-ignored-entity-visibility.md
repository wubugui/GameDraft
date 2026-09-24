---
target: entity-visibility-channels
date: 2026-09-23
session: 游戏关卡与演出问题修复
---

现象: 头顶气泡（EmoteBubbleManager）挂在实体层作兄弟节点，实体按时段/条件隐掉后气泡照挂；头顶闲聊（BubbleChatterSystem）也照样挑藏着的人说话——制作人看到"夜里人都没了，话还在那儿"。卡里没列"跟着实体显隐的旁挂表现"这一族消费者。
证据: src/data/types.ts isEmoteAnchorShown（气泡每帧照抄实体容器 visible、闲聊不挑藏着的人、走近型藏着不算进半径）；src/systems/BubbleChatterSystem.test.ts「说话人被藏起来就不说」。
建议: entity-visibility-channels 补一句：挂在实体层的旁挂表现（气泡、名牌之类）不随实体容器藏，必须读 isEmoteAnchorShown 这一个判据自己跟。
