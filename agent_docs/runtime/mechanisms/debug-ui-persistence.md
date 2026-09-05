---
id: debug-ui-persistence
title: 调试/编辑器偏好与「游戏↔编辑器活数据」的持久化范式
domain: runtime
type: mechanism
summary: 按内容性质分三档:调试/编辑器偏好落 editor_data;游戏↔编辑器的活数据交换也走 editor_data 但必须按"对讲机"设计(服务端版本号+writer+新鲜期);工程数据游戏侧一律不写。玩家设置不归本卡。localStorage 已彻底清退
status: active
authority:
  - vite.config.ts#debugDockPinsApi
  - vite.config.ts#runtimeLightingApi
  - src/dev/runtimeLightingSync.ts#shouldApplyDoc
  - tools/editor/editors/scene_lights.py#should_apply_doc
  - src/dev/narrativeDebugBridge.ts
  - resources/editor_projects/editor_data/debug_dock_pins.json
triggers:
  paths: ["src/ui/**", "src/dev/**", "vite.config.ts", "tools/editor/editors/scene_lights.py"]
  topics: [调试面板, 偏好持久化, localStorage, F2, sidecar, 实时同步, 同步槽, 长挂通道]
  tasks: [加调试UI, 记用户偏好, 做游戏与编辑器的实时同步]
verified_by:
  - src/dev/runtimeLightingSync.test.ts
  - tools/editor/editors/tests/test_scene_lights.py
last_governed: 2026-09-03
---

## 是什么(一句话)

游戏进程要"记住点什么"或"跟编辑器换点什么"时的合规范式。**按内容性质分档,不按宿主位置分**
(旧卡按 "vite 中间件 / QWebChannel 桥" 分,那条分法已作废,见下):

| 档 | 例子 | 落在哪 | 谁能写 |
|---|---|---|---|
| **调试/编辑器 UI 偏好** | F2 pin、Flag 收藏、调试器开关 | `editor_data/*.json`(dev 中间件) | 游戏侧直接写 |
| **游戏↔编辑器的活数据交换** | 光照同步槽 | 同上,但**必须按"对讲机"设计** | 两侧都写,规则见下 |
| **工程数据** | 场景 JSON、内容 JSON | 工程文件 | **游戏侧一律不写**,只有编辑器统一保存出口落盘 |

**作用域**:玩家设置(音量 / 文字显示 / 按键)**不归本卡**——它属于玩家数据面,
与存档同一个后端,见 [runtime-persistence](runtime-persistence.md)。两个面不要混:
本卡这三档全都**运行时永不加载**、也不进发行包,玩家设置反之。

## 权威源(读代码从哪进)

`vite.config.ts` 里 `/__gamedraft-api/…` 那一族中间件(`debugDockPinsApi` = 偏好档的最小样板,
`runtimeLightingApi` = 交换档);两侧同口径判定在 `runtimeLightingSync.ts::shouldApplyDoc`
↔ `scene_lights.py::should_apply_doc`;调试器开关的收口在 `Game.enableNarrativeDebugBridge` /
`teardownNarrativeDebugBridge`。`editor_data/` 下已有的 JSON 即现成范式。

## 硬契约(违反即 bug)

- **禁止 localStorage**(2026-07-07 拍板,2026-08-28 收紧成"连首帧种子都不留")。
  游戏在多个端口、编辑器内嵌 WebEngine、打包 exe 三种壳里跑;localStorage 按 origin 隔离、
  WebEngine 可能不落盘 ⇒ 换端口/重启即"失忆"。**也不要先做 localStorage 版再返工。**
  运行时现存的 localStorage **读取**只剩一次性旧数据迁移。
- **不许走 QWebChannel 桥**(2026-08-21 实测否掉)。让编辑器直接问游戏,只在"游戏正好跑在
  编辑器内嵌页签里"时成立;**制作人的游戏开在外部浏览器,整条线是断的**,而且表现成
  "拉取失败:游戏没返回数据",看不出根因。**dev server 是唯一两边都始终可达的点。**
- **交换档必须是"对讲机",不是状态存档**。四条缺一即静默出错:
  ① **版本号由服务端自增**——客户端自己编号会在两边同时写时撞车;
  ② **自己写的不读回来**(比对 writer 身份)且**只吃比见过的更新的**——
     少任一条就是无限回声写循环;
  ③ **跨场景绝不套用**——游戏停在别的场景时套过来 = 把参数写进错的场景,当场看不出来;
  ④ **有新鲜期**——没这道闸,昨天的残留会在今天一开就被当成"对面刚改的"套回来,
     把中间存过的改动顶掉。
  ⑤ **按时段归属拆、按时段合**(2026-09-04):游戏在非基底时段发布的 lighting 是
     `基底 ⊕ timeVariants[该时段].lighting` 的合并结果。收:环境块里与基底不同的进该时段的
     变体、相同的从变体里去掉,灯与其余键写回基底(`scene_lights.split_phase_pull`);
     发:发 `基底 ⊕ 该时段覆盖`(`merge_lighting_for_phase`,与运行时 mergeSceneLighting 同式)。
     此前手动拉取一律拒收、自动同步却没拦——合并后的夜值直接灌进白天基底,而编辑器发回去的
     裸基底又把正在夜里的游戏变成白天。护栏 `tools/editor/tests/test_time_variant_editing.py`。
  两侧各实现一份,**必须各锁一份同口径测试**:规则分家不报错,只表现为"某一边偶尔不跟"。
- **它要连着跑几小时,所以"早就断了却没人知道"是默认死法**。三条不那么显然的:
  ① **in-flight 标志会成为静默死因**——一发请求永不 settle(dev server 重启到一半),
     标志就永远为真、同步零痕迹地停摆;超时之外还要一道看门狗兜住标志泄漏。
  ② **连接状态必须常驻可见**,而且要出现在人**正在看的那几个面**上,不是只写日志。
  ③ **端口不固定要能自愈**:按候选表逐个试、**试通就钉住**,钉住的连不上就松开重轮
     (要自愈的是编辑器那一侧;游戏侧用相对 URL 天然跟着页面走)。
- **偏好档的读写时机**:构造时 + 每次打开面板时 GET 同步,改动即 POST;
  非 dev 构建降级为内存并 log 提示。
- **开关类偏好:入口可以多,拆桥必须单一**。同一个开关允许有多个入口(调试面板 / 控制台
  全局 / 标题界面 / URL),但它们必须共用同一对 enable/disable;
  **拆桥尤其只许有一条路径**(摘事件 + 摘 observer + dispose 一次做完)——
  两份拆法一漂就是 HMR 后"点一下上报两条"。
- **异步读回来的偏好不许覆盖人刚扳的开关**。工程文件是 fetch 回来的**旧时间线**,
  中途人点了任一入口就必须让位(一个"用户已决定"的闸)。属"旧时间线不写新状态"的一个面。

## 已知坑

- **`localhost` 可能静默连不通**:dev server 只监听 IPv4 而 Python 的 urllib 先试 IPv6,
  表现为整整数秒超时后失败;而 vite 启动日志打的恰恰是 `localhost`,照抄进来就是
  "同步永远连不上且不报错"。Python 侧连接层统一改写主机名,有同名护栏测试。
- 同一面板的偏好散进多个文件会难以对齐;新键先看现成 JSON 的范式再加。
- 交换档里的"临时视图状态"(独奏之类)交出去前要还原成真实值,但**不要强退**——
  同步每秒都在跑,强退会让人刚点开就被踢出来。忙时(拖动中 / 表单有焦点)只发不收。

## 怎么验证

改完重启 dev 服 + **换一个端口**打开,偏好仍在,`editor_data/` 下对应 JSON 有内容。
交换档另做一次断网演习:只拦这一条路径,看退避是否起来、状态行是否变、服务恢复后是否自动连回。
