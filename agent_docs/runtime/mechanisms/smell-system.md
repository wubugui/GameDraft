---
id: smell-system
title: 气味系统(双层 action/zone)
domain: runtime
type: mechanism
summary: action 层永远压过 zone 层;zone 气味声明式挂 ZoneDef.smell,SmellSystem 听 zone:enter 驱动,ZoneSystem 不动
status: active
authority:
  - src/systems/SmellSystem.ts
  - src/ui/smell/SmellIndicatorRenderer.ts
  - src/ui/HudDebut.ts
  - public/assets/data/smell_profiles.json
triggers:
  paths: ["src/systems/SmellSystem.ts", "src/ui/smell/**", "src/ui/HudDebut.ts", "public/assets/data/smell_profiles.json"]
  topics: [气味, smell, 香粉味, 嗅, 气味显隐, 鼻子教程]
last_governed: 2026-09-10
---

## 是什么(一句话)

玩家当前"闻到什么"的常驻机制:`SmellSystem` 内部两层——action 层(动作驱动)+ zone 层
(场景 `ZoneDef.smell` 声明式触发),合成一个生效气味给 HUD 与条件系统。

## 权威源(读代码从哪进)

`src/systems/SmellSystem.ts`(两层合成、zone 订阅、serialize);词库与烟形数据在 `smell_profiles.json`。

## 硬契约(违反即 bug)

- **优先级**:生效 = action 非空取 action,否则 zone,否则无味。`clearSmell` 后若仍在 zone 内,
  zone 气味自动浮回。
- **生效值单点广播**:进 FlagStore(`current_smell*`)+ `player:smellChanged` 事件(含 source);
  消费方读这两处,别自己再算。
- **serialize 只存 action 层**:zone 层是玩家位置的瞬时函数,读档进场由 zone:enter 重建。
- zone 重叠取最后进入。
- `setSmell`/`clearSmell`/`sniff` 是**写存档态的普通 command、不在 cutscene allowlist**——
  演出里要出味,在演出前后用普通 command,别塞 present 步。
- zone 触发是声明式的:改气味触发逻辑动 SmellSystem 的订阅,不动 ZoneSystem。
- **HUD 指示器默认不显、动作控显**(玩法清单 G.6,2026-09-10;与三把火 G.5 同构):
  `setSmellVisible{visible, style}` 落 flag `smell_hud_visible`(真相、入存档)→ HUD 投影;
  隐着时 SmellSystem 两层照常算、flag/条件照常,只是不画(连常驻基线雾也不画)。
  `style` 与三把火同一套词:flare(聚拢浮现+吸气声,显缺省)/ fade(散开上飘淡出+呼气声,隐缺省)/
  instant(读档恢复)/ debut(首次出场仪式,返回 Promise,后面接 `showSystemNote{smell}`)。
  首次点在雾津街头包子铺:zone `z_包子铺_香`(baozi + source)+ `z_包子铺_初闻`(条件 not sysnote_smell,
  onEnter debut → 说明卡)。**仪式整段跑在 GameState.Cutscene、说明卡整段跑在 UIOverlay**
  (`Game.runInGameState`,与 startCutscene / 压力小游戏 runSegment 同一套"记原态→切→恢复"),
  世界停住靠状态机,**不许**再加按键抑制那类补丁(制作人 2026-09-10 骂过)。
  仪式由 `src/ui/HudDebut.ts` 通用件驱动(三把火共用),音效走 systemSfx 表
  `smell:debut/show/hide`。渲染器(`SmellIndicatorRenderer.setVisible`)缺省仍是显——编辑器预览要直接看见。
- **飘向 = 气味源的反方向,每帧现算**(G.6):`dir` 不再是作者静态值——`setSmell.dir` / `ZoneSmellConfig.dir`
  **已废、不生效**。源 = zone `smell.source{x,y}` 或动作 `setSmellSource{x,y,scene?}`(action 源压 zone 源、
  只在所属场景生效、入存档);开关 `setSmellTracking`(flag `smell_tracking`,缺省开)。关/无源/源不在本场景/
  无味 → dir=0。玩家位置与场景 id 由组装层 getter 注入(`setPlayerPositionGetter/setSceneIdGetter`),
  `update()` 里算、变化 ≥0.01 才广播。源在左 → 往右飘(dir>0)。

## 已知坑

- "闻不到"先查 profile 再查代码:衰减参数在数据里(hold 时长不够就是秒衰减)。
- 分不清谁在压谁:F2「系统」页标记生效来源;`?smellDebug` 暴露 `__smell*` 钩子。

## 怎么验证

F2 工具页可实时调烟形并读出可粘回 JSON 的数值;流程验证走
[runtime-command-channel](../recipes/runtime-command-channel.md)(进出 zone + setSmell 断言 FlagStore)。
