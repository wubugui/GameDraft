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
  topics: [命令通道, runtime-command, 快照, playerView, rAF 节流, 时间断言]
last_governed: 2026-09-03
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
- **预览页里"游戏内时间"会被拉长,倍数还浮动**:pane 的 rAF 被节流到个位数 fps,而主循环
  给每帧 dt 设了上限——于是游戏内累计时间按那个上限逐帧前进,一个 1 秒的游戏内阈值实测要
  十几秒墙钟才到(真机 60fps 下仍是准确的 1 秒)。凡**按游戏内时长**判定的逻辑(超时、冷却、
  兜底放弃、节目间隔、延迟事件)在预览页验证时都会被拉长,很容易误判成"逻辑没生效"
  而去改本来正确的代码。**对策**:一律轮询等**终态**(封口了没 / 标志位对不对 / 告警发了没),
  **不要**按墙钟设固定 sleep 再断言;要看进度就读**游戏内累计量**,别读墙钟差值。
- **通道对参数零兜底,数值必须自己夹**。命令入口是裸暴露给外部的,喂进去的数不夹值会一路产出
  非数,而越界与碰撞那些判据碰上非数**一律判 false 放行**,于是它被写进玩家世界坐标、相机跟着
  一起坏 —— 表现是整个世界渲染不出来、**不报任何错、且这一局不可逆**。新增命令类型时,
  夹值是硬要求,不是防御性编程。
- **快照是单槽、最后写者赢**:`targetBootId` 只管命令消费,不隔离快照写入——多实例同跑时
  GET 到的可能是别的实例(页签/编辑器 WebEngine)写的。严肃断言在页内直读 `window.__game`
  私有字段,不经共享通道。
