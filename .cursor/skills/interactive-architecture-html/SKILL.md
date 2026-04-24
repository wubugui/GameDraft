---
name: interactive-architecture-html
description: Produces single-file interactive C4 container + function-chain architecture HTML matching GameDraft/tools/chronicle_sim_v3/data/architecture-v3.html (same layout, CSS classes, and JS behaviors). Use when the user asks for an interactive architecture diagram, C4 + 关键函数 HTML, 交互架构图, architecture-v3 style page, or diagrams for GameDraft runtime vs tools/editor.
---

# 交互式 C4 架构图 HTML（与 architecture-v3 同形）

## 规范参考（只读、不可改交互契约）

以 `GameDraft/tools/chronicle_sim_v3/data/architecture-v3.html` 为**唯一版式与行为范本**。新图必须与该文件**同形**：

- 同一套 `<style>`（颜色、布局、`#view`/`#side`、`.box-card`、`.ff-*`、`details` 结构等）
- 同一套 DOM 骨架：`header`（标题、说明、`c4-tab`、`bar` 按钮、图例）、`.main`、`#view`（`zoom-ctl`、`scene-context`、`scene-container`、`#c4zoom`、`#ch-panel`）、`#side`
- 同一套交互逻辑：Tab 切换场景、容器卡 `mouseenter` 右侧说明、`data-exp` 卡 **双击** 展开/折叠函数树、**Shift+双击** 仅折叠该模块、`foldAll2`/`openDetails`/`closeDetails`、画布 **Ctrl+滚轮** 与右下角缩放按钮

允许改动的只有：**文案、C4 框内容、`T` / `FLOWS` / `exp` 数据、以及为对齐业务而调整的 `scene` 内 HTML 节点**（仍须沿用相同 class / `data-cid` / `data-exp` 约定）。

## 交付物位置（默认约定）

| 子系统 | 建议输出路径 |
|--------|----------------|
| GameDraft 主游戏（Vite/运行时） | `GameDraft/docs/architecture-gamedraft-runtime.html`（仓库内已有初版；迭代时仍须保持与 v3 同壳） |
| `GameDraft/tools/editor` 主编辑器 | `GameDraft/tools/editor/data/architecture-editor.html`（仓库内已有初版） |

若用户指定其他路径，以用户为准；**仍须单文件自包含**，不引入外部 JS/CSS 依赖。

## 实施流程

### 1. 复制外壳

1. 复制 `architecture-v3.html` 全文为新文件。
2. 删除或替换**仅与 chronicle_sim_v3 业务绑定**的段落：`<title>`、`<h1>`、header 内 `<p>` 说明、`scene-context` / `scene-container` 里具体框与箭头文案。
3. **保留** `<style>` 块与 `<script>` 内**非数据**的结构：`esc`、`collectFromLayer`、`buildOneLayer`、`buildImplTree`、`buildFnCell`、`buildFlowModule`、`showHelp`、`bindFfn`、`renderPanel`、Tab/双击/缩放/折叠等事件绑定逻辑。

### 2. 填 C4 第一层（系统上下文）

- 使用 `scene-context` 内现有模式：`details.ctx-det` + `.c4-ctx` + `.box.person` / `.ext` / `.sysb`，每个参与者/系统块设 `data-cid="ctx_*"`。
- 在脚本里 `T` 对象为每个 `ctx_*` 提供 `{ k, t }`（与参考一致）；需要时在 `fn_*` 上增加 `layers` 做实现下钻（字段形状与参考相同：`layers: [{ s, t, layers?: ... }]`）。

### 3. 填 C4 第二层（容器主链）

- 在 `scene-container` 的 `.c4-pipe` 中用 `details.c4-sec` 分「层 1/2/3…」叙述打包、主依赖链、测试/虚线等；**主链**用 `.c4-lane` + `.box-card` + `.c4-acon` 内联 SVG 箭头。
- 每个容器卡：`data-cid="coll_*"`（悬停说明），若该目录/模块有函数树则再加 **`data-exp="<key>"`**，且 `<key>` 必须出现在下方 `FLOWS` 与 `exp` 中。
- `.box-card` 的语义色 class 沿用参考：`cli`、`eng`、`npack`、`aist`、`dres`、`aux`、`composite` 等，**不要随意发明新 class 名**（若必须新增视觉类别，先复用最接近的现有 class，避免改 CSS）。

### 4. 定义函数链数据（`FLOWS` + `T`）

- `FLOWS[key]` 形状固定：`title`、`note`（可空字符串）、`stages`（每步 `label`、`fromPrev` 可选、`items: [{ id: "fn_...", n: "展示名" }]`）、`links`（`a`/`b`/`t`）。
- 每个 `items[].id` 必须在 `T` 中有条目：`{ k: "文件或符号定位", t: "摘要", layers?: [...] }`。
- 脚本底部 `var exp = { ... }` 的 **key 集合** = 所有 `data-exp` 用到的 key；初值一律 `false`，与参考一致。
- `renderPanel` 里 `order` 数组：按**主游戏或编辑器**的真实叙述顺序排列模块 key（可参考 v3 的 `cli → engine → ...`，但内容随子系统而变）。

### 5. 内容取材（主游戏 vs 主编辑器）

**GameDraft 主游戏**

- 从入口（如 `main`/`bootstrap`、场景加载、规则/Action 系统、UI 层、存档与资源管线）梳理**一条可讲述的主链**，再拆到 2～4 个 `c4-sec` 层（数据 → 主链 → 外围/测试）。
- 外部系统框用 `.box.ext`（引擎 API、文件系统、若有的网络等）；人用 `.box.person`。

**`tools/editor`**

- 从编辑器入口（主窗口/应用类）、工程与图数据加载、各子面板与校验/保存链路梳理主链；外部系统可包含「磁盘上的 GameDraft 数据目录」「与本机 Python/校验脚本」等。
- 函数树 `FLOWS` 应对齐真实调用顺序（例如：打开工程 → 读 JSON/图 → UI 编辑 → 保存前校验 → 写回）。

### 6. 自检清单（完成后在浏览器打开文件）

- Tab「1 系统上下文 / 2 容器」切换正常。
- 容器页：悬停各 `data-cid` 框与函数块，`#side` 文案正确且无空白 key。
- 带 `data-exp` 的卡：双击展开底部 `#ch-panel`，再双击折叠；Shift+双击仅收当前模块。
- 「全部折叠函数树」「全展开子层」「全折起子层」作用范围符合预期（与 v3 相同：`#view` 内所有 `details`）。
- Ctrl+滚轮与 `+ / − / 1:1` 缩放 `#c4zoom`，长内容在 `#view` 内可滚动，右侧说明栏可滚动，**小屏下主要内容不被永久裁切**（保持参考页的 `max-width`/`overflow` 策略）。

## 反例（禁止）

- 改用 React/Vite/SVG 编辑器导出另一套 UI，却声称「与 v3 同形」。
- 删减缩放、侧栏、`details` 下钻或双击展开函数树等交互。
- 把 `T`/`FLOWS` 迁到外部 JSON 并异步加载（破坏单文件、离线可开）。

## 可选延伸阅读

若需对照项目架构文字，可结合 `游戏架构设计文档.md` 与 `GameDraft/docs/` 下相关说明；**HTML 仍以 v3 文件为版式最高优先级**。
