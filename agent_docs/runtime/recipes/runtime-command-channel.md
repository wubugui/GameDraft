---
id: runtime-command-channel
title: 运行时命令通道(脚本化驱动游戏)
domain: runtime
type: recipe
summary: HTTP 命令队列驱动 DEV 游戏+读快照断言;测试/操作游戏一律走它,不用 computer-use/点像素
status: active
authority:
  - vite.config.ts
  - src/core/devRuntimeCommands.ts
  - src/core/Game.ts#pollRuntimeCommands
triggers:
  paths: ["src/core/devRuntimeCommands.ts", "vite.config.ts"]
  tasks: [测试游戏, 驱动游戏, 流程验证, e2e]
  topics: [命令通道, runtime-command, 快照, playerView]
last_governed: 2026-08-05
---

**实测环境与日期**:2026-06 live 验证(数百命令往返 <1.3s 不卡死);2026-07 位面/立绘/背尸多轮实战沿用;2026-07-13 隐藏 pane 节流与快照竞态两坑实测。

## 机制

- Vite dev 服中间件(`vite.config.ts` 的 gamedraft-runtime-command-api)提供 HTTP 队列,
  路径 `/__gamedraft-api/runtime-command`,队列落 `resources/editor_projects/editor_data/production_workbench/`。
- POST `{commands:[...]}` 入队;DEV 游戏定时轮询取走(`Game.pollRuntimeCommands`)逐条执行,
  再把状态发到 `/__gamedraft-api/runtime-debug-snapshot`。命令可带 `targetBootId` 定向页签。
- 命令 TTL 30s,由**服务端**在 GET/POST 时剪枝(专为清 targetBootId 孤儿命令),客户端不剪。
- 命令词汇与快照字段的权威清单读 `src/core/devRuntimeCommands.ts`;扩展观测通常只需加快照
  字段,不必加命令。

## 用法

1. `preview_*` 把游戏跑起来(必须 DEV 模式,轮询器才消费队列)。
2. Bash `curl` POST 命令;GET 快照读回——**真正数据嵌在返回的 `.snapshot` 字段**。

## 铁律

- **不要用 computer-use / Chrome 点像素操作游戏**。
- **流程测试禁作弊**:只读 `playerView`(玩家可感知信息,不含 flag/节点 id)、只用 `player*`
  命令;`debugSet*`/setFlag 直推状态 = 失去流程测试意义。`player*` 命令即发即走不 await
  游戏逻辑,不会卡死。

## 坑

- 断言"切完场景"用 `currentSceneData.id`——`currentSceneId` 切场景**起点**就置了。
- 平滑走路在 rAF 节流下冲过头 → 定位用 setPlayerCollisions + debugSetPlayerPosition 瞬移;
  渲染类验证配合 [headless-visual-verification](headless-visual-verification.md)。
- 队列文件跨会话共享:别的 dev server 在轮询时会把你的命令消费掉(先探针确认再驱动)。
- **"queue 清零但命令从未执行"= 隐藏 pane 下轮询本身被节流**到 ~1/分钟,命令 30s TTL 先到期
  被服务端剪掉。对策:整页刚 reload 后立发,或把 POST+等待放进同一次页内 eval 保活;
  页面被频繁整页刷新时 `targetBootId` 极易成孤儿,短流程宁可不定向。
- **快照是单槽、最后写者赢**:`targetBootId` 只管命令消费,不隔离快照写入——多实例同跑时
  GET 到的可能是别的实例(页签/编辑器 WebEngine)写的。严肃断言在页内直读 `window.__game`
  私有字段,不经共享通道。
