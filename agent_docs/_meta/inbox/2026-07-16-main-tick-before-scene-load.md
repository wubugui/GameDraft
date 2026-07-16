---
target: scene-onenter-reveal-timing
date: 2026-07-16
session: 开场NPC刷屏修复(续)
---

现象: onEnter 起长演出的契约成立,但主 tick 原在初始场景装载**之后**才挂载——开场演出全程世界冻结:玩家容器滞留世界原点(0,0)、NPC 动画定格首帧、通知不弹、深度遮挡/光照 uniforms 不更新(实体渲染成半透)。ESC 跳过后点完对话 loadScene 才返回、ticker 才挂,一切"突然正常",极易误诊为过场收尾 bug。
证据: Game.start 原序 loadInitialScene→…→ticker.add;dev 直达路由注释本已写明"主 tick 已挂载才安全执行";修复=把 ticker.add 挪到场景装载前(src/core/Game.ts),真机验证主角出现在出生点、掌柜半透消失。另:dev 构建现挂 window.__game 句柄(命令通道配方"直读私有字段"从此有据)。
建议: 卡里补一条硬契约:"主 tick 必须先于任何场景装载挂载,onEnter 演出才有世界侧驱动";诊断口诀:开场演出期间实体位置/动画/滤镜异常而跳过后正常≈tick 未挂。
