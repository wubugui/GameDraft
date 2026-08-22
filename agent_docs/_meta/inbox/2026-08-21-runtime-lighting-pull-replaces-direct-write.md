---
target: debug-ui-persistence
date: 2026-08-21
session: 运行时编辑模式 v1（在真实画面里摆灯）+ 光照双向实时同步
---

# 场景光照：游戏侧写盘通道下线，改为与编辑器**双向实时同步**

- **删掉了**：`/__gamedraft-api/scene-lighting`（vite 中间件直接写场景 JSON）、F2「光影」页的
  「存回场景 JSON」按钮、运行时编辑模式的 Ctrl+S 写盘。`tools/vite/jsonTextPatch.ts`
  （保格式定点替换 + 12 条单测）随之退役——它只服务那一个端点，且从未提交过。
- **新机制**：`/__gamedraft-api/runtime-lighting` 是一个**同步槽**（`editor_data/runtime_lighting.json`）。
  游戏（`src/dev/runtimeLightingSync.ts`）与编辑器（`scene_lights.LightingSyncClient` +
  `main_window._tick_lighting_sync`）各 400ms 轮询一次：任一边改了 `lighting`，另一边下一拍就跟上，
  **不用按任何按钮**。落盘仍然只有编辑器 `save_all` 一个出口——同步只负责把参数搬过去入脏。
- **为什么不是 WebEngine 桥**：第一版让编辑器用 `runJavaScript` 直接问游戏，
  只在"游戏正好跑在编辑器内嵌页签/弹出窗口里"时成立。**制作人的游戏开在外部 Chrome，
  整条线是断的**，而且表现为"拉取失败：游戏没返回数据"，看不出根因。dev server 是唯一
  两边都始终可达的点：先到的写、后到的读，任一边中途开/关/重启都自动接上（实测整页 reload
  后游戏立刻adopt了槽里的共享状态）。

## 四条必须成立的规则（两侧各实现一份，各锁一份同口径测试）

判定源：`src/dev/runtimeLightingSync.ts::shouldApplyDoc` ↔
`tools/editor/editors/scene_lights.py::should_apply_doc`。规则分家不报错，只表现为
"某一边偶尔不跟"，极难查。

1. **`rev` 由服务端自增**，客户端自己编号会在两边同时写时撞车。
2. **自己写的不读回来**（`writer ≠ 我`）+ **只吃比见过的新的**（`rev > lastSeen`）——
   少任何一条就是无限回声写循环。
3. **跨场景绝不套用**：游戏停在别的场景时套过来 = 把灯摆进错的场景，且当场看不出来。
4. **新鲜期 5 分钟**：槽是"当前会话的对讲机"不是状态存档。没这道闸，昨天调灯的残留会在
   今天一开就被当成"对面刚改的"套回来，把中间存过的改动顶掉。

另有两条"忙时只发不收"：游戏侧**拖灯中**、任一侧**独奏中**（独奏是临时视图状态，
交出去前用 `exportFixup` 还原成真实开关，但**不强退独奏**——同步每秒都在跑，
强退会让你刚点开独奏就被踢出来）；编辑器侧**表单有焦点**或**画布定位模式**开着时同理。

## ⚠ `localhost` 在这台机器上连不通（踩过，且是静默的）

vite 只监听 IPv4，Python 的 urllib 会先试 IPv6 `::1`：实测
`http://localhost:5173` **3 秒超时**、`http://127.0.0.1:5173` **0.00 秒返回**。
而 vite 启动日志打的恰恰是 `http://localhost:5173/`——照抄进来就等于同步永远连不上，
且不报错只是"没反应"。已在 `scene_lights.normalize_dev_base_url` 统一改写，护栏测试同名。

## 本卡要改的地方

卡里「传输两种：vite 中间件(游戏内) / QWebChannel bridge(内嵌编辑器)」这句现在会误导人。
建议改成按**内容性质**分，而不是按位置：
- **UI 偏好**（F2 pin、Flag 收藏、debug dock）→ vite 中间件写 `editor_data/`；
- **游戏 ↔ 编辑器的活数据交换**（光照同步槽）→ 同样走 vite 中间件写 `editor_data/`，
  但要按"对讲机"设计：版本号 + writer + 新鲜期，缺一就是回声或残留复活；
- **工程数据**（场景 JSON 这类）→ 游戏侧一律不写，只有编辑器 `save_all`。

## 「连着连着就没了」的五个死法（制作人硬要求，逐条堵死并有测试）

这条通道要长期挂着跑，且**游戏同时还连着别的调试通道**（命令通道、快照上报、
叙事调试器 WebSocket 5211）。下面每一条的症状都是"以为在同步、其实早断了"：

1. **请求挂死** —— `fetch` / `urlopen` 默认无超时。dev server 重启到一半时那一发可能永不
   settle，而 `inFlight` 标志永远为真 ⇒ 同步静默死亡、零痕迹。
   对策：两侧都有短超时（TS `AbortController` 2s / Python 0.6s），外加 TS 侧 15s
   `inFlight` 看门狗（标志一旦因未来改动泄漏成真，这是唯一能自愈的兜底）。
2. **失败后死磕** —— 连不上仍按 400ms 猛发：刷屏、抢别的调试通道带宽，编辑器侧还卡 UI 线程。
   对策：两侧指数退避 400ms → 3s，**一成功立刻回到 400ms**。
3. **断了没人知道** —— 对策：`RuntimeLightingSync.statusLine()` /
   `LightingSyncTransport.status_line()`，F2 光影页、编辑模式 HUD、编辑器灯位面板三处常驻显示。
4. **端口变了就永远连不上** —— dev server 不一定在 5173（launch.json 里就有 5174/5178/5180/5188），
   用户自己起的服更随意。对策：编辑器侧连接层按候选表逐个试、**试通就钉住**；钉住的那个
   连不上就松开重轮（dev server 换端口后就是这么自己找回来的）。游戏侧用相对 URL，
   天然跟着页面端口走。
5. **`localhost` 静默超时** —— 见上一节的 IPv4 坑。

**端口占用：本机制不新增任何监听端口。** 游戏侧是页面自己 origin 上的一条新路径，与命令通道 /
快照 / scene-list 同属一个 vite middleware 链（实测五条端点并存全部 200）；叙事调试器那条
WebSocket 另开端口，互不相干。

实测断网演习（只拦 `runtime-lighting` 这一条路径，别的通道不动）：
连接正常 poll=400ms → 断 3.5s 后 failStreak=3、退避到 3000ms、状态行显示
「⚠ 同步已断 5s（自动重连中）」→ 服务恢复后 **1.2s 内自动连回**、poll 回到 400ms。

## 顺带记一条：编辑器算「离地高度」的口径是偏的

`scene_editor._recompute_light_heights` 用「把灯投影到画布、在落点采地面」反推离地高度。
深度图里"深度恒定"的一片**不是**世界里的水平地面（45° 视角下是斜面），所以这个估计会随
高度一起爬：实测抬高 300 wu，估出来的地面跟着爬 150 wu，读数只剩一半。运行时侧已改成解
`world(q).x/z == 灯的 x/z ∧ q.z == ground(q.xy)`（**迭代必须带阻尼**，真水平地面上裸迭代
恰好在两个值之间震荡），见 `src/authoring/lightSpace.ts` 的 `groundBelow` 与其单测。
Python 侧这一份还没跟上——它只影响 UI 读数与「在画布上定位」的输入，不进数据契约。
