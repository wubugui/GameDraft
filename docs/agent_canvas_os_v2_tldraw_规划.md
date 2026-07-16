# Agent Canvas OS v2 (tldraw) — 完整实现规划 · 待审批

> **状态(2026-07-08)**:v1(infinite-canvas)押错了轴(以生成为核心)。已确认**核心 = 人机共创 surface**。据此**推翻画布层、换基座到 tldraw**。
> 本文件是**整套完整规划**(非 MVP),供审批;审批通过前不动一行代码。v1 见 `agent_canvas_os_设计与规划.md`(降级为参考)。

---

## A. 核心与完整范围

**核心**:一块**人机共创的交互 / 感知 / 指挥 surface**——人**看 / 指(deixis)/ 审 / 干预**;agent **感知整块画布 + 全权动手 + 随意操作**;万物(参考 / 代码 / 文档 / 图 / 人的手绘)**可寻址、可感知**。生成只是 agent 顺手的一件事。

**完整范围(全做,不砍)**:

1. tldraw 共创画布(人的 surface)+ **服务端权威 store**(多端合并)
2. **外部任意 agent 经 MCP** 完全感知 + 完全操作画布
3. **手绘 deixis**:人画圈/箭头/圈选 → agent 认出"指的是谁"
4. **流程连线**:绑定箭头(结构化边)+ agent 读出流程图
5. **两个世界**:画布原生 shape vs 只读引用 shape(指向仓库)
6. **生成走 agent**(libtv 文生图/图生图 → image shape,带溯源)
7. **导出膜**(人把关:画布 → 仓库 + manifest + 校验)
8. **拖 / 粘任何东西**进画布
9. **多 agent + 人 共创**(tldraw sync 节点级合并,不 clobber)
10. **作者 / 溯源**(每 shape 带 author + source)
11. **语义整理**(agent 按语义分簇布局,含主动提问)
12. **完全独立** + 一键启动 + 接 GameDraft 网页总控

---

## B. 架构

> **决策(2026-07-08):真·sync server,现在跑本地、设计成可迁托管。** 它就是**一个标准 tldraw sync server**(`TLSocketRoom`)——**现在**跑在你本机(`start.sh` 起,localhost),**以后迁云 = 同一套代码部署到服务器 + 客户端改个 URL,不重构**。为此钉死三条:**① 地址(host/port/WS URL)、持久化后端、鉴权 全走配置**,代码里不硬编码 localhost;**② 不假设"本地即可信"**——鉴权边界先留好(本地留空,托管再填);**③ 权威 store 现落本地文件,可换 DB/卷,不动上层**。它是**权威 tldraw store**;人的浏览器 + 所有 agent 都连它。好处:① 画布存服务端(不绑浏览器 IndexedDB,稳、可携带、可迁)② 人 + 多 agent 合并走 tldraw **真·sync**(节点级、不 clobber)③ agent 桥**直接读写权威 store**。代价:多一个进程(折进 start.sh)。deixis 几何在服务端/浏览器侧算。下方"后端/服务端"均指**此进程(现本地,将来可托管)**。

```
  ┌─────────────────────────── canvas-os 后端 (Node/TS, 一处) ───────────────────────────┐
  │                                                                                      │
  │   tldraw 权威 store(headless, @tldraw/sync-core + schema)  ── 落盘持久化(SQLite/文件) │
  │        ▲                    ▲                                                         │
  │        │ sync(WS)          │ 直接读写 records                                        │
  │        │                   │                                                         │
  │   [sync 服务]          [MCP 服务]  ── 感知 + 操作 + deixis几何 + 生成 + 导出           │
  └────────┼───────────────────┼─────────────────────────────────────────────────────────┘
           │                   │
   人:tldraw 客户端        外部 agent(Claude Code / GPT·Codex / Gemini,经 MCP stdio/HTTP)
   (React, 画/指/审)                    │
                                shell out ↓
                          libtv CLI(生成) · 游戏 python 校验器(导出) · 仓库文件(引用/导出)
```

**要点**:store 在**服务端权威**(不是 v1 那种"浏览器推整张 state" → 天然解决 clobber、多 agent 合并、持久化)。人客户端与所有 agent 都连这一个后端;后端一个进程里同时跑 **sync 服务** 和 **MCP 服务**,MCP 直接读写权威 store,改动经 sync 广播给所有端。生成/校验 **shell out** 到 libtv CLI 与游戏 python(与画布解耦,v1 逻辑复用)。

**三个包**:

- `canvas-os-server`(Node/TS):tldraw 权威 store + sync 服务 + MCP 服务 + 持久化。
- `canvas-os-web`(React + tldraw):人的客户端,自定义 shape、拖粘、极简 chrome。
- `canvas-os-agent`(并入 server 的 MCP 层 + shell 适配):感知/操作/deixis/生成/导出工具。

---

## C. 数据模型(tldraw records + 我们的 meta)

用 tldraw 内建 shape 为主,少量自定义;每个 shape 挂 `meta`(tldraw shape 原生支持 `meta`)。

| 用途 | shape | 关键 meta |
|---|---|---|
| 生成图 / 贴入图 | `image`(内建)+ asset | `author`, `source:{tool,mode,prompt,model,ref,ts}`, `role` |
| 文本 / prompt / 文档 | `text` / `note`(内建) | `author`, `source`, `role:prompt\|doc\|…` |
| **流程连线 / 指向** | `arrow`(内建,可 bind 两端) | `kind:"flow"\|"pointer"`, `semantic`(如"生成参考") |
| **手绘 deixis** | `draw`(内建,freehand,有 `segments` 点集) | `kind:"gesture"` |
| **只读引用**(指向仓库) | 自定义 `reference` shape | `repoPath`, `symbol?`, `readonly:true`, `author:"human"` |
| 几何标注 / 便签 | `geo` / `note`(内建) | `author` |

- **溯源 append-forward**:生成/改动 = 新 shape,旧的不动(§多 agent 不互抹)。
- **两个世界**:画布原生(image/text/draw/arrow/geo)= 导出前只在画布;`reference` shape = 只读指向仓库,不改内容(内容归 git/PyQt)。
- **持久化**:store records 落盘(sync 持久层或 SQLite),画布"住"在后端,换浏览器也是同一张。

---

## D. 关键机制(逐条,含工具契约)

### D1. 感知(MCP 只读)
- `canvas_snapshot()` → 全部 shape(id/type/page 位置 x,y/宽高/旋转/几何/文本或 asset 引用/meta)+ 全部 arrow 绑定 + 当前选区 + 相机。**agent 的完整读**。
- `read_selection()` → 当前选中 shape 及摘要。
- `read_pointing()` → 遍历 `draw`(gesture)与 `arrow`(pointer),几何算出各自"**指向谁**",返回 `[{gestureId, refersTo:[shapeIds], kind:"enclose"|"point"}]`。

### D2. 手绘 deixis(几何,后端算)
- **圈选/套索**:`draw` shape 的 `segments` 点集 → 构成多边形 → 点在多边形内判定(命中 bounds 中心或重叠比例阈值)→ 圈住的 shapes。
- **箭头指向**:`arrow` → 若终端 bind 到某 shape,即目标;否则取终点最近/被包含的 shape。
- 产物喂给 agent:"人这个圈 = 指这几个 shape / 这箭头 = 指那个 shape",agent 据此改/生成/删。

### D3. 完全控制(MCP,读写全权)
`create_shape`(任意类型)、`update_shape`、`delete_shapes`、`move_shapes`、`resize_shape`、`rotate_shape`、`duplicate_shapes`、`create_arrow`(带两端 binding)、`bind/unbind`、`set_camera`、`select`、**`apply_batch`**(一次批量任意 ops,重排/重建整张画布)。= "快速、彻底、完全控制"。

### D4. 流程连线
- `create_arrow(from, to, {kind:"flow", semantic})` → 绑定箭头,移动跟随。
- `canvas_snapshot` 里 arrow 的两端绑定 = agent 读出的**流程图**(谁→谁)。语义在 `meta`。

### D5. 生成(agent 侧,复用 v1)
- `generate_image(prompt, x,y, model?)` / `img2img(ref_path, prompt, …)` → **shell libtv**(文生图 / `modeType=image2image` 图生图,v1 已跑通)→ 下载 → 建 `image` shape(挂 asset + 溯源 meta)。**不碰 tldraw 任何"生成"假设**(它本就没有;生成纯 agent 侧)。

### D6. 导出膜(人把关,复用 v1)
- `export_shape(shapeId, destPath, project_root?)` → 取该 image shape 的 asset 字节 → 写仓库 + 追加 manifest + **shell 游戏校验器**(`asset_reference_audit` + `dev.sh validate-data`)。画布→仓库唯一口。

### D7. 拖 / 粘任何东西
- tldraw 原生支持拖放/粘贴 图/文本(`registerExternalContentHandler`);任意文件:文本类→`text` shape 内联,其它→`reference`/占位 shape。比 v1 补 handleDrop 干净(tldraw 有正式外部内容钩子)。

### D8. 多 agent 共创
- tldraw sync 后端权威 + 节点级合并 → 人 + 多 agent 同 store 不打架(v1 的"整张 state 覆盖"根治)。每 shape `meta.author` 标谁建的。

### D9. 语义整理
- agent `canvas_snapshot`(shape+内容+arrow 绑定)→ LLM 按语义分簇(prompt↔图:靠 arrow 绑定 / prompt 文本匹配 / `source` lineage)→ 算布局 → `apply_batch` 批量 move → 含糊先问人。**语义归 LLM,几何归函数**。

---

## E. 技术选型(含理由)

| 项 | 选 | 理由 |
|---|---|---|
| 画布 | **tldraw SDK** | 万物皆可感知 shape + 手绘 deixis 原生 + 成熟 + agent kit |
| 前端 | React + `<Tldraw>` + 自定义 ShapeUtil | tldraw 标准 |
| 后端 | **Node/TS**(tldraw 是 TS) | store/shape 操作必须在 TS 侧;一个进程跑 sync + MCP |
| 同步/store | `@tldraw/sync`(自托管 Node WS + `TLSocketRoom`) | 服务端权威、节点级合并、持久化 |
| 持久化 | sync 持久层 / SQLite + asset blob 目录 | 本地优先,画布住后端 |
| agent 协议 | 官方 MCP SDK(Node) | 任意 agent 无关接入 |
| 生成/校验 | **shell out** libtv CLI + 游戏 python | 与画布解耦,复用 v1 |
| home | 自己的 repo | 完全独立 |

**许可**:tldraw SDK 为商用 source-available(开发免费;**生产要 license key 或挂水印,或付费**)。自用无碍,**分发/商用前过法务**——这条要你先接受。

---

## F. 实现阶段(完整建全,非 MVP;这是"建造顺序",每阶段都是承诺交付)

| 阶段 | 交付 | 验收 |
|---|---|---|
| **1 后端骨架 + 人客户端** | `canvas-os-server`(tldraw 权威 store + sync + 落盘)+ `canvas-os-web`(连 sync,渲染 shape) | 浏览器开画布、画东西、刷新还在;多标签同 store 合并 |
| **2 MCP 感知 + 完全控制** | MCP:`canvas_snapshot`/`read_selection` + 全套 shape CRUD/批量/复制/箭头绑定 | 外部 agent(我)零人工读整块画布 + 建/改/删/连任意 shape |
| **3 手绘 deixis** | `draw`/`arrow` 几何:enclosure + 指向 → `read_pointing` | **我读出"人画的圈套住了哪个 shape / 箭头指谁"并改它** |
| **4 流程连线语义** | 绑定箭头 + `meta.kind/semantic`;snapshot 读出流程图 | agent 读出"谁→谁"的流程关系 |
| **5 生成 + 导出接回** | libtv 文生图/图生图 → image shape;导出膜(复用 v1) | 参考图→图生图→贴 shape;导出到仓库+校验双 0 |
| **6 拖粘任何东西 + 引用 shape** | 外部内容钩子;`reference` 只读引用 shape(两个世界) | 拖图/文本/文件/URL 都成 shape;拖仓库文件成只读引用 |
| **7 多 agent + 人共创** | sync 多端 + `meta.author` 溯源 | 人 + 多 agent 同画布,节点级合并、标注作者、不互抹 |
| **8 语义整理** | agent 分簇布局 + 主动提问 | "prompt+它的图+参考"聚一簇,含糊先问 |
| **9 总控接入 + 一键起 + 文档** | `scripts/start.sh`;GameDraft `dev_console` 加按钮;README | 网页总控点一下即起即开 |
| **10 打磨** | 感知保真、审查吞吐、拖粘/deixis UX、许可收尾 | 端到端顺手 |

**北极星(§H)在阶段 3 落地**;5 之后基本是平移 v1 的活。

---

## G. 复用 vs 重建

- **复用(不白干)**:libtv 生成(文生图/图生图/upload/download 已跑通)、导出膜逻辑与校验器接法、**整套设计理念**、GameDraft 总控接法。
- **重建**:整个画布层——tldraw 客户端 + `canvas-os-server`(store/sync/MCP)+ 感知/操作/deixis。**丢弃** infinite-canvas 及其补丁、`canvas_os` 的 23-工具驱动层与节点模型。
- **净**:推翻"画布 + 驱动层";agent 侧能力与理念平移。**不是从零。**

---

## H. 北极星 / 全系统验收

> **外部任意 agent 经一个 MCP:读整块 tldraw 画布(含人手绘)→ 认出人的 deixis(圈/箭头指谁)→ 全权操作 shape(增删改查/复制/连线/批量)→ 顺带生成、导出;人 + 多 agent 同画布共创、节点级合并、带作者溯源。**
> 落到"**人画个圈,AI 就懂你指谁并动手**"——v1 给不了的那一下。

---

## I. 风险与坑(诚实)

1. **自建 tldraw agent 桥是最大工作量**——tldraw 不送(infinite-canvas 送了)。核心不确定性集中在阶段 2/3(headless store 读写 + 几何 deixis)。
2. **tldraw SDK 商用许可**——生产 key/水印,分发前过法务。
3. **tldraw sync 后端**要学要搭(自托管 `TLSocketRoom`)。
4. **栈从 Python 转 Node/TS**(store 操作在 TS 侧;生成/校验仍 shell python)。
5. **丢弃 v1 已验证的画布层**(生成/导出/理念不丢)。

---

## J. 待你拍板的决策点(审批时一并定)

1. **接受 tldraw 商用许可?**(自用没问题;将来分发/商用要么挂水印要么付费)——不接受这条,整个 v2 不成立。
2. **home**:`canvas-os` 独立 repo(推荐)。
3. **后端栈 = Node/TS**(store 必须),生成/校验 shell 到现有 libtv/python——认可?
4. **本地 sync server(已定)**:tldraw sync(`TLSocketRoom`)跑在**本机进程**(localhost,不托管远程),权威 store 落**本地文件**——比浏览器-store 更稳。
5. **v1 处置**:先**原封保留**(不删),v2 阶段 3 北极星验证通过后再决定退役——认可?

---

**审批**:以上整套认可就说"批准";要改哪块(范围/阶段/选型/决策点)直接点,我改完再报。**批准前不动代码。**
