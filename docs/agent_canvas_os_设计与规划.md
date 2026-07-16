# Agent Canvas OS — 设计结论与实现规划

> **状态(2026-07-08)**:方向已定并 **headless 实测通过**——**采用开源 `infinite-canvas` 当基座 + 几层薄封装**,不自建内核。**薄封装已全部建成并实测,代码在 `~/AIWork/agent-canvas-os`,见 §10。**
> 本文件为权威。§1 是"现在要做什么";§2–§6 是概念地基与理据;§7 是被降级的自建方案(保留备选);列举型内容以代码为准。

---

## 0. 一句话

**一个完全独立、AI-native 的共创画布:任意 agent(Claude Code / GPT·Codex / Gemini / 自研…)经 MCP 或 HTTP 驱动同一张无限画布;生成是 agent 的能力(走 LibTV CLI 等)、结果贴回画布;画布上的东西导出前只在画布里,导出是通往真项目仓库、唯一一道由人把关的膜。基座直接用开源 `infinite-canvas`。**

---

## 1. 落地决定(2026-07-08):采用 infinite-canvas + 薄封装

### 1.1 决定
基座 = **[`basketikun/infinite-canvas`](https://github.com/basketikun/infinite-canvas)**(AGPL-3.0 + CLA,React/Vite/Zustand,自研无限画布,非 tldraw)。它开箱就有:无限画布 + 多画布 + 生成落节点 + **内置 23 工具的 agent 驱动面(MCP + HTTP)** + 本地存储。我们**不自建内核**,只在其上加几层薄封装。

### 1.2 为什么(两点合力)
1. **调研**(§6):扒了 ~12 个项目,没有一个是"整套现成的";但 infinite-canvas 覆盖了"自由画布 + agent 经 MCP 驱动 + 生成 + 多画布"一整块,是最接近的现成货。
2. **你放宽了严格 append-only**(§3.4):接受"**LibTV 式**——生成往后加新节点、重跑覆盖旧输出、节点可变"。这一放,恰好砍掉了"整个赛道没人做、必须自建"的那一块(git 撑底的不可变版本 DAG)。剩下的都能拿现成的用。⇒ 从"自建"翻成"采用"。

### 1.3 已实测(2026-07-08,全程 headless、我扮演外部 agent、零人工递文件)
- **现成可用**:clone → 装依赖(`canvas-agent`: `npm install && npm run build`;`web`: `npm install --legacy-peer-deps`,本机无 bun)→ 起两个进程(`web` :3000 + `canvas-agent` 桥 :17371)→ 画布正常渲染。
- **agent 无头驱动画布**:URL 参数 `?agentUrl=…&agentToken=…` 自动连(免手点);
  - **裸 HTTP** POST `/api/tools`(带 token)→ `canvas_get_state` 读、`canvas_create_text_node` / `canvas_create_image_prompt_flow` 写,节点即时出现;
  - **真 MCP stdio 客户端**(= GPT/Codex/Gemini/Cursor 走的路)→ 握手拿到 **23 工具**、`callTool` 建节点成功。
  - 二者是**同一条路**:MCP server 只是 `/api/tools` 的瘦封装(`mcp-server.ts`)。
- **生成与画布解耦**(你的核心诉求):agent 外部生成的图,用 `canvas_create_node(image, {content:"data:image/png;base64,…"})` 塞进去 **直接渲染**——**零 infinite-canvas 改动、不需要任何 OpenAI key、不碰它自带的生成节点**。
- **全 agent 无关**:MCP 类(Claude/**GPT·Codex**/Gemini/Cursor)+ 裸 HTTP 类(任意脚本/框架)都通;**GPT·Codex 是一等公民**(自带 Codex 侧边栏 + Codex app 插件 + `codex mcp add`)。

### 1.4 我们只需自己写这几层薄封装
1. **生成贴图 adapter(必做,agent 侧编排,infinite-canvas 零改动)**:
   `agent 用 libtv-cli 生成 → 拿到图片文件 → base64 → canvas_create_node(image, {content: dataURI})`。
   可包成一个 skill/脚本让 agent 一步完成。**优化项**(非阻塞):贴大量 2K 图时,把 data URI 换成"存 blob → 节点引 `storageKey`"(它自带生成就这么存,照抄)。
2. **作者/溯源标记(必做,对齐你在乎的溯源)**:建节点时在 `metadata` 里盖 `author`(哪个 agent / human)+ 可选来源(prompt/seed/参考图 id)。infinite-canvas 不自带"哪个 agent 建了哪个节点"的归属,这层薄补。
3. **导出膜(按需,这是原设计里仍归我们的一块)**:画布节点 → 写 `public/resources` 等 + manifest + **跑 `asset_reference_audit` / `validate-data`**,人手动触发。画布↔项目的唯一一道口。
4. **(可选)隐藏它自带的 OpenAI-key 生成节点**,或留着当"临时快速生成"备用。
5. **(按需)多画布用途组织 / "待归置区" / 作者过滤等 UX**——用到再说。

### 1.5 授权与边界注记(采用前须知)
- **AGPL-3.0 + CLA**:个人/本地自用无碍;若要**分发或闭源商用**,先过法务(AGPL 传染 + CLA)。
- 数据存**浏览器 IndexedDB**(localforage),非磁盘文件;UI 版本 v0.5.0、**开发阶段、不保证数据兼容**——当自用工具,别当稳定生产版。
- 官方那句"Claude 侧边栏暂未开"只指**画布内置助手**(现 wire Codex);**不挡外部 agent 经 MCP 驱动**(我们就走这条)。
- 经 `/api/tools`/MCP 的写**默认无二次确认、直接落画布**(自主);"人在环上"的确认闸只在**侧边栏助手**那条 UX 上。要人工把关就走导出膜(§1.4-3)或自加。

### 1.6 与"自建内核"方案的关系
§7 那套"自建内核(tldraw + git 撑底的 append-only DAG + 自写 MCP + 内核先行)"**降级为备选**,仅当将来:① 你要回到**严格 append-only 溯源**(agent 永不覆盖你的手笔),或 ② 要**彻底脱离 infinite-canvas / 换 tldraw / 商业分发** 时,再回看。届时:版本 DAG 直接照 **git 对象模型**、导出血缘用 **C2PA(`c2pa-rs`)**、生成引擎无头调 ComfyUI/LibTV(见 §6/§7)。

---

## 2. 它解决的真实痛点(立项理由,不变)

| 痛 | 现状 | 怎么解 |
|---|---|---|
| **A. 找参考喂 agent 苦** | 满仓库翻、贴给 agent,或让它慢搜 | 参考常驻画布、可指点;agent 也能自己找到摆上;agent 直接解析你递的画布引用 |
| **B. 生成多版本/审计图找不到** | 生成到临时目录就散了 | 生成/贴图**落画布成节点**,一眼看见、可组织 |
| **C. 你丢了对项目的空间感** | agent 全代劳,记不住东西在哪 | 画布把项目地图还给你:靠"认得出"导航,而非"叫得准" |

---

## 3. 核心设计原则(概念地基)

- **3.1 图/画布是真相,画布与 agent-API 是两个对等终端;任意 agent 平级接入。** —— infinite-canvas 用"画布状态 + `/api/tools`(MCP 瘦封装)"实现了这条,已实测多 agent 无关。
- **3.2 AI-native 判据**:agent 能无人工中介地读写画布。—— 已实测(裸 HTTP + 真 MCP 客户端)。
- **3.3 人机对等 + 一处 root**:agent 全自主读写/整理/审;**只有「导出」和「哪版算数的终判」归你**。—— 导出膜是我们自加的那道 root 闸(§1.4-3)。
- **3.4 版本模型 = LibTV 式(已放宽)**:生成往后加新节点、重跑覆盖、节点可变即可;**不追严格 append-only 不可变 DAG**。代价:LibTV 式下"重跑会覆盖旧输出"这个洞还在(agent 可能盖掉上一版)——**已接受**;靠"作者标记 + 需要时手动留存"缓解,不靠不可变 DAG。
- **3.5 两个世界**:画布原生内容(导出前只在画布) vs 指向外部文件的只读引用;导出是唯一的膜。
- **3.6 生成是抽象的**:生成是 agent 的能力(LibTV/ComfyUI/手画都行),画布只是结果落地处;**不绑定 infinite-canvas 自带的 OpenAI-key 生成节点**。—— 已实测(贴图渲染)。
- **3.7 完全独立 + 多画布各有其用 + 可有可无**:自成一体、项目对它零依赖;画布随便建、每张有用途;删了不影响项目本体。
- **3.8 注意力是稀缺资源**:agent 通读画布、审计归纳、把该看的挑给你 = 分诊机;画布默认推待审、settled 收起。

---

## 4. 关键机制在 infinite-canvas 里的落点

| 设计要素 | 对应实现 | 我们做什么 |
|---|---|---|
| agent 感知/读 | `canvas_get_state / get_selection / export_snapshot` | 直接用 |
| agent 写内容/结构 | `canvas_create_node/text/config`、`apply_ops`、`connect/move/resize/delete/update` 等 23 工具 | 直接用 |
| 生成落画布 | `canvas_create_node(image,{content:dataURI})`(贴外部生成) | 薄封装 adapter(§1.4-1) |
| 多 agent 接入 | MCP(`<agent> mcp add … @basketikun/canvas-agent mcp`)/ 裸 `/api/tools` | 直接用 |
| 自动连接 | `?agentUrl=&agentToken=` URL 参数 | 直接用 |
| 溯源/作者 | 无原生归属 | 薄封装:`metadata.author` + 来源(§1.4-2) |
| 导出到项目 | 无(只有整画布 JSON 导出) | 自写导出膜(§1.4-3) |
| 存储 | 浏览器 IndexedDB(localforage;图 blob 走 `storageKey`) | 沿用;大图量后续优化 |

---

## 5. 明确砍掉的(防止反复立项)

- **自建画布引擎 / git 撑底的 append-only DAG 内核**:你放宽到 LibTV 式后不需要(除非回到严格溯源,见 §1.6)。
- **CRDT / Yjs 自建协作同步**:不写;多 agent 共处靠同一个桥/token 打同一张画布即可。
- **Tauri 桌面壳、embedding 向量搜索**:多余/过早。
- **"一切皆 node" / 把代码·游戏json 存进画布再编辑**:代码/结构化数据继续 git + PyQt + `validate-data`,画布只只读引用,避免双真相源。
- **依赖 infinite-canvas 自带的 OpenAI-key 生成**:不用它;生成走 agent(§3.6)。

---

## 6. 竞品调研结论(为什么是 infinite-canvas)

一句话:整套没有现成的;胜负手是 ②agent 无头驱动 / ⑤严格版本 DAG / ⑥两世界+导出膜。放宽 ⑤ 后,infinite-canvas 胜出。

- **infinite-canvas ✅ 采用**:自由画布 + 23 工具 MCP(Claude Code/Codex 实测已接)+ 生成 + 多画布 + 本地;短板(可变存储、浏览器 IndexedDB、AGPL)在放宽后可接受。
- **NodeTool**(AGPL,Electron 桌面,内置 MCP + `nodetool mcp install --claude`,落盘磁盘,本地模型):基建更硬,但偏 ComfyUI 节点图、不那么"自由卡片"——**次选**。
- **tldraw agent 套件 / MCP App**:感知/动作架构一流可**参考**,但 SDK 生产需 license+水印、MCP App 仅 3 工具且生成与 MCP 两 kit 不合体——不当基座。
- **OpenCove**(MIT,React Flow,agent 经 Control Surface 读写画布节点):同品类、但无生成/溯源、agent 面是 CLI/HTTP 非 MCP——严格溯源自建时的**候选基座**。
- **Open-Generative-AI / OpenHands Canvas / Flowith / Slashspace / Koubou**:分别因"非画布/agent 经终端/闭源 SaaS/太薄"出局。
- 严格溯源那条路的现成拼图(仅 §1.6 备选时用):**git 对象模型**(=改即新节点+可变 ref)、**C2PA `c2pa-rs`**(生成→导出血缘)、ComfyUI(无头生成引擎)。

---

## 7. 附:自建内核方案(降级为备选,保留作理据)

仅当回到严格 append-only 或脱离 infinite-canvas 时启用。要点:
- **内核先行**:先建"语义图(SQLite:内容节点/只读引用节点/边/canonical 指针/审核态/跨画布身份)+ agent syscall(MCP)",可视画布是其上一个终端。
- **版本 = append-only 不可变、content-addressed**:改即新节点、只有 canonical/head 指针可变、永不静默覆盖 = **git 对象模型**;媒体 blob 版本用 git/DVC/lakeFS,导出血缘用 **C2PA**。
- **两层分清**:画布/空间层(如 tldraw store 或 React Flow) vs 语义层(图),`shape.nodeId` 挂钩;把溯源塞进 shape 属性 = 跟工具对着干。
- **选型铁律**:能用成熟件绝不自造(画布 tldraw、协议 MCP SDK、版本 git、生成 LibTV/ComfyUI)。
- 完整推演见本仓库 git 历史中本文件早期版本。

---

## 8. 待定的小取舍(动工前拍板)

1. **生成贴图**:先走 data URI(简单)、还是一上来就 blob+`storageKey`(省空间)。倾向先 data URI。
2. **作者标记粒度**:只记 `author`,还是连 prompt/seed/参考图一并进 metadata。
3. **导出膜**:先做不做、导哪些域(先只做媒体到 `public/resources`?)。
4. **home**:infinite-canvas 放自己的 repo(独立性最强,推荐)还是 `tools/` 下。
5. **多 agent 隔离**:所有 agent 共一张画布(共创,默认),还是按 agent 各起一个桥/端口隔离。

---

## 9. 北极星 / 验收 —— ✅ 已达成(2026-07-08)

> **外部 agent(含真 MCP stdio 客户端),零人工递文件,能自己:建画布、读画布状态、建节点、把外部生成的图贴成 image 节点并渲染;且 Claude / GPT·Codex / 任意 MCP 或 HTTP 客户端都走同一入口。**
> 已 headless 实测通过。"ai 读写画布不需要人类帮助""全 agent 无关接入""生成与画布解耦"三条从口号变成事实。剩下是那几层薄封装(§1.4)。

---

## 10. 实现状态(2026-07-08 已建成并 headless 实测)

薄封装(§1.4)全部实现,代码在 `~/AIWork/agent-canvas-os`(完全独立于游戏工程):

| 层 | 文件 | 实测 |
|---|---|---|
| canvas 客户端 + 作者/溯源节点 | `canvas_os/client.py` · `nodes.py` | ✅ author/source metadata 经画布往返不丢 |
| 生成贴图(libtv → 画布) | `canvas_os/generate.py` | ✅ Z-image Turbo 真出图 → 贴 image 节点(28s,零 OpenAI key、不碰自带生成节点) |
| 导出膜(→ 项目 + 校验) | `canvas_os/export.py` | ✅ 导出 1280×720 真图 + manifest(带溯源),asset_audit + validate-data 双 code 0 |
| 暴露给任意 agent | `canvas_os/cli.py` · `mcp_server.py` · `~/.claude/skills/agent-canvas-os/SKILL.md` | ✅ CLI + 自建 MCP(4 工具,stdio 客户端实测)+ Claude skill |
| 一键起停 + 永久家 | `scripts/start.sh` · `stop.sh` · `README.md` · `infinite-canvas/`(已迁入) | ✅ start.sh 从家一键起 → CLI 真生成渲染 |
| **拖 / 粘贴任何东西进画布**(人给 agent 递上下文) | `infinite-canvas/…/project.tsx` 前端补丁(`handleDrop` + `paste` 监听 + 共用 `createNodeFromFile`,搜「Agent Canvas OS 补丁」) | ✅ 拖或 Cmd+V:.md/.json→文本节点内联(agent 可读)、图/媒体→媒体节点、其它文件→占位、文本/URL→文本节点;实测拖 3 类 + 粘 2 类均落节点 |

**跑法**:`bash ~/AIWork/agent-canvas-os/scripts/start.sh` → 浏览器打开它打印的画布 URL(自动连 agent)→ `python3 -m canvas_os gen "…"` / `export latest <path>`。任意 agent 接入见 `README.md` 与 skill。

**已知**(详见 README):LibTV 式可变(重跑覆盖);程序化 move/set_viewport 需 reload 才视觉生效(数据不丢);infinite-canvas 自带生成的 `storageKey` 图暂不支持外部导出(我们贴的 data URI 图可导);基座 AGPL-3.0 + CLA,分发/闭源前过法务。
