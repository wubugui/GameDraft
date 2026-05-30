# Graph 工具功能验收清单

审计日期：2026-05-31

当前口径：

```text
1. 独立 GUI：除“直接编辑 YAML 文本/写回当前光标字段”之外，所有查看、检查、运行、诊断、Trace、关系阅读都统一在这里验收。
2. VS Code：只验收写 YAML 时必须贴着编辑器发生的能力，例如 diagnostics、completion、hover、definition、rename、code action、空间字段 picker 写回。
3. 命令行：只作为开发者兜底，不作为策划日常验收入口。
```

当前已验证：

- `npm run content:check` 通过。
- `npm run planner:gui -- --smoke` 通过。
- GUI 版本：`unified-reference-v9`。
- Runtime compatibility 为 `ok: true`。
- 当前内容没有 error；warning 数量以 GUI `问题列表` 刷新结果为准。

## 一、独立 GUI 主入口

目标：策划不需要记命令行；非文本编辑类能力都能在 GUI 里运行、查看、复制、保存日志。

入口：

```powershell
npm run planner:gui
```

或双击：

```text
tools/planner_gui/start_planner_gui.cmd
```

### 1.1 基本布局

验收步骤：

1. 启动 GUI。
2. 查看左侧。
3. 查看右侧。

预期：

- 窗口标题是 `GameDraft Graph 工作台`。
- 左侧有 `日常验收`、`其它命令`、`打开位置`。
- 左侧区域有滚动条，按钮不会因为窗口高度不够被截断。
- 右侧上方是状态摘要。
- 右侧下方有四个 tab：
  - `Build`
  - `问题列表`
  - `关系诊断`
  - `命令日志`

状态：可验收。

### 1.2 Build 分页

验收步骤：

1. 切到 `Build`。
2. 点击 `Game Authoring: Build Content`。
3. 点击 `Game Authoring: Validate Content`。
4. 点击 `一键完整检查`。

预期：

- `Build Content` 会生成/刷新 `artifact/content_pipeline/**` 和 runtime preview。
- `Validate Content` 只检查内容，不应写产物。
- `一键完整检查` 等同主工具链验收，会跑 build、diagnostics、simulate、runtime compatibility、LSP smoke、单测、VS Code extension compile。
- 命令运行时按钮会禁用，结束后恢复。
- 命令日志自动保存到 `logs/planner-gui-*.log`。

状态：可验收。

### 1.3 问题列表

验收步骤：

1. 切到 `问题列表`。
2. 点击 `刷新诊断列表`。
3. 查看右上状态摘要。
4. 选中一条问题，点击 `复制选中问题`。
5. 点击 `复制全部问题`。
6. 点击 `打开选中文件`。

预期：

- 当前没有 error。
- warning 用黄色显示。
- 如果后续有 error，应显示红色。
- 复制内容可直接粘贴给工具负责人。
- 有源文件的问题可以打开对应文件。

状态：可验收。

### 1.4 模拟默认流程

验收步骤：

1. 点击左侧 `模拟默认流程`。
2. 查看 `命令日志`。
3. 切到 `关系诊断`，选择 `Runtime Trace Timeline`。

预期：

- 日志中显示策划可读摘要，不直接刷完整 JSON。
- 摘要包含是否成功、是否阻断、路线、选择、关键状态变化、事件数量和诊断数量。
- `artifact/content_pipeline/simulation_result.json` 被刷新。
- `Runtime Trace Timeline` 能显示本次模拟事件。

状态：可验收。

### 1.5 选择模拟案例

验收步骤：

1. 点击左侧 `选择模拟案例...`。
2. 选择 `authoring/simulations/ringboy_snatch_route.json`。
3. 查看 `命令日志`。
4. 切到 `关系诊断`，选择 `Runtime Trace Timeline`。

预期：

- 模拟成功。
- 能看到 dialogue route、option 选择、关键 diff、signal/narrative/quest 连锁变化摘要。
- 完整 action/source 细节保留在 `artifact/content_pipeline/simulation_result.json`。
- GUI 内能查看事件详情并复制。

状态：可验收。

### 1.6 关系诊断

验收步骤：

1. 切到 `关系诊断`。
2. 点击 `生成/刷新 Content Index`。
3. 依次切换 `查看类型`：
   - `Signal Flow`
   - `Flag Read/Write`
   - `Quest Dependency`
   - `Dialogue Graphs`
   - `Runtime Trace Timeline`
4. 在过滤框输入关键词，例如 `ring`、`quest`、`flag`。
5. 点击列表中的任意对象。
6. 点击 `复制详情`。

预期：

- `Signal Flow` 能显示 signal 的 emitter/listener/read 关系。
- `Flag Read/Write` 能显示 flag 类型、reader、writer。
- `Quest Dependency` 能显示 quest 标题和读写关系。
- `Dialogue Graphs` 能显示 dialogue graph 声明和引用关系。
- `Runtime Trace Timeline` 能显示模拟事件顺序、事件类型、phase、label 和 source。
- 详情里能看到 `file`、`line`、`column`、`symbol`、`path` 等定位信息。
- 过滤能缩小列表。
- 详情能复制。

状态：可验收。

### 1.7 Trace Resolve

验收步骤：

1. 先运行一次模拟，确保有 `simulation_result.json`。
2. 切到 `关系诊断`。
3. 点击 `Trace Resolve 文件...`。
4. 选择 `artifact/content_pipeline/simulation_result.json`。
5. 查看 `命令日志`。
6. 打开 `artifact/content_pipeline/runtime_trace/resolved_trace.json`。

预期：

- 日志中输出事件到源文件的映射。
- `resolved_trace.json` 中每个可解析事件带有：
  - `runtimeRef`
  - `sourceId`
  - `source.file`
  - `source.line`
  - `source.runtimePath`

状态：可验收。

### 1.8 其它命令下拉

验收步骤：

1. 在左侧 `其它命令` 下拉框逐项选择命令。
2. 点击 `运行选中命令`。

需要覆盖：

- `content:render`
- `content:runtime-compatibility`
- `content:lsp-smoke`
- `content:simulate summary`
- `content:simulate case...`
- `content:explain summary`
- `content:explain case...`
- `content:trace-resolve file...`
- `新建 dialogue YAML 模板...`
- `新建 narrative YAML 模板...`
- `新建 quest YAML 模板...`
- `content:check`
- `project:test`
- `project:build`
- `narrative-editor:build`
- `vscode-extension:compile`

预期：

- 低频一次性命令都能从 GUI 跑。
- `content:build` / `content:validate` 在 `Build` tab，不放在下拉里。
- `content:diagnostics-json` 在 `问题列表` tab 的 `刷新诊断列表` 按钮，不放在下拉里。
- `content:index` 在 `关系诊断` tab 的 `生成/刷新 Content Index` 按钮，不放在下拉里。
- `content:watch` 不放入下拉，因为它是长驻命令，会占住 GUI。

状态：可验收。

### 1.9 新建 YAML 模板

验收步骤：

1. 在 `其它命令` 下拉里选择：
   - `新建 dialogue YAML 模板...`
   - `新建 narrative YAML 模板...`
   - `新建 quest YAML 模板...`
2. 只输入显示名称。
3. 选择模板。
4. 选择保存位置。
5. 如果目标文件已存在，分别测试取消覆盖和确认覆盖。

预期：

- 不要求策划输入 id。
- 工具根据显示名称自动生成不重名机器 id。
- 中文显示名不会直接当 id。
- 编译器同时保留机器 id 和显示名：
  - quest 用 `title/name`
  - narrative 用 `title/name/graphLabel`
  - dialogue 用 `meta.title` 或顶层 `title/name`
- dialogue 默认从 `authoring/dialogues` 开始，可选 `npc` / `scenario` 等子目录。
- narrative 默认从 `authoring/narrative` 开始，可选 `flows` / `npc` 等子目录。
- quest 默认从 `authoring/quests` 开始，可选 `side` 等子目录。
- 模板不能保存到对应根目录之外。
- 覆盖前必须确认。
- 临时验收文件要删除，避免污染内容。

状态：可验收。

### 1.10 命令日志

验收步骤：

1. 切到 `命令日志`。
2. 运行任意命令。
3. 拖选一段日志，点击 `复制选中`。
4. 点击 `复制全部`。
5. 打开 `logs` 目录。
6. 找到本次命令自动生成的 `planner-gui-*.log`。
7. 可选：点击 `保存日志...`，手动另存一份。

预期：

- 每次运行命令都会自动保存日志文件，不需要手动点保存。
- 状态区会显示当前自动保存的日志路径。
- `保存日志...` 只作为手动另存，不是唯一保存方式。
- 日志颜色区分 error、warning、success、命令行和普通输出。

状态：可验收。

### 1.11 打开位置

验收步骤：

1. 点击 `打开 authoring 源目录`。
2. 点击 `打开策划操作指南`。
3. 点击 `打开诊断报告`。
4. 点击 `打开模拟结果`。
5. 点击 `打开 Runtime Preview`。

预期：

- GUI 只提供入口和结果，不堆具体内容文件。
- 对应文件或目录能打开。

状态：可验收。

## 二、VS Code YAML 编辑辅助

目标：内容编辑留在 VS Code；只有“必须贴着文本光标”的能力在 VS Code 里验收。

准备：

1. VS Code 打开 `D:\GameDraft`。
2. Run and Debug 选择 `Run GameDraft Authoring Tools`。
3. 按 F5 启动 Extension Host。
4. 在 Extension Host 里打开 `D:\GameDraft`。

如果不用开发模式，也可以安装本地扩展：

```powershell
npm --prefix tools/vscode-game-authoring run install:local
```

### 2.1 扩展命令可见

验收步骤：

1. 在 Extension Host 中按 `Ctrl+Shift+P`。
2. 搜索 `Game Authoring`。

预期能看到：

- `Game Authoring: Build Content`
- `Game Authoring: Validate Content`
- `Game Authoring: Refresh Diagnostics`
- `Game Authoring: Show Action Schema Help`
- `Game Authoring: Pick Spatial Field (auto-detect)`
- `Game Authoring: Pick Map Position`
- `Game Authoring: Edit Polygon`
- `Game Authoring: Edit Patrol Route`
- `Game Authoring: Pick Spawn Point`
- `Game Authoring: Pick Zone`
- `Game Authoring: Pick Entity`

说明：

- `Build Content`、`Validate Content`、`Refresh Diagnostics` 在 VS Code 里可见即可，主验收入口是独立 GUI。
- `Open Planner Dashboard` 是旧 VS Code Webview 工作台入口，不再作为主流程验收。
- `Open Graph / Reference View` 是旧 VS Code 关系视图入口，主验收入口改为独立 GUI 的 `关系诊断` tab。
- `Show Action Schema Help` 是兜底查说明；日常应优先依赖自动补全和 hover。

状态：需要 VS Code 人工验收。

### 2.2 YAML Diagnostics

验收步骤：

1. 打开 `authoring/dialogues/npc/ringboy.yaml`。
2. 运行 `Game Authoring: Refresh Diagnostics`。
3. 查看 Problems 面板。

预期：

- 当前工程 warning 能显示到对应 YAML/CSV 行。
- 没有 error。
- 点击 Problems 里的条目能跳到源文件行。

状态：需要 VS Code 人工验收。

### 2.3 未保存文本诊断

安全验收方式：

1. 新建临时文件 `authoring/dialogues/_tmp_acceptance.yaml`。
2. 写入一个 entry 指向不存在 node 的 dialogue。
3. 不保存或保存后运行 diagnostics。
4. 查看是否出现 target missing 诊断。
5. 删除临时文件。

示例：

```yaml
id: tmp_acceptance
entry: start
nodes:
  start:
    type: line
    text: test
    next: missing_node
```

预期：

- 能报出 next 指向不存在节点。
- 能定位到临时 YAML。

状态：需要 VS Code 人工验收。

### 2.4 Completion

验收步骤：

1. 打开任意 narrative YAML。
2. 在 `signal:` 后按 `Ctrl+Space`。
3. 打开 dialogue YAML，在 action `type:` 或 `params:` 附近按 `Ctrl+Space`。

预期：

- `signal:` 附近优先补 signal。
- action type 附近补 action 类型。
- action params 附近补对应字段。
- `Show Action Schema Help` 只是补全之外的兜底说明。

状态：需要 VS Code 人工验收。

### 2.5 Hover

验收步骤：

1. 打开 `authoring/dialogues/npc/ringboy.yaml`。
2. 鼠标悬停在 flag、signal、quest、dialogue graph id 上。

预期：

- hover 显示引用说明、归属或来源。
- 对未登记引用应提示问题。

状态：需要 VS Code 人工验收。

### 2.6 Definition

验收步骤：

1. 在 YAML 里选中一个 flag/signal/quest/dialogue graph 引用。
2. 按 F12 或右键 `Go to Definition`。

预期：

- flag 跳到 `authoring/tables/flags.csv` 对应行。
- signal 跳到 `authoring/tables/signals.csv` 对应行。
- quest 跳到 quest YAML 或 `quests.csv`。
- dialogue graph 跳到对应 dialogue YAML。

状态：需要 VS Code 人工验收。

### 2.7 References

验收步骤：

1. 在 YAML 或 registry 表中选中一个 flag/signal/quest id。
2. 按 `Shift+F12` 或右键 `Find All References`。

预期：

- 能列出 reader/writer/listener/emitter 等引用位置。
- 点击引用能跳转。
- 全局关系阅读优先用 GUI `关系诊断` tab。

状态：需要 VS Code 人工验收。

### 2.8 Rename Symbol

验收步骤：

1. 在临时 YAML 或临时 registry 行上选择一个测试 id。
2. 按 F2。
3. 输入新 id。
4. 检查相关引用是否同步修改。
5. 撤销或删除临时测试文件。

预期：

- rename 不应只改当前一处。
- 相关引用应一起更新。

状态：需要 VS Code 人工验收，建议只在临时内容上测。

### 2.9 Code Action

验收步骤：

1. 制造一个可诊断问题，例如未登记 signal。
2. 光标放到诊断位置。
3. 按 `Ctrl+.`。

预期：

- 出现可用 quick fix 或说明性 action。
- 执行后能辅助修正或打开相关帮助。

状态：需要 VS Code 人工验收。

### 2.10 Semantic Tokens

验收步骤：

1. 打开 authoring YAML。
2. 观察 id、signal、flag、action type 等语义字段是否有区分。

预期：

- 语义 token 不影响内容。
- 若当前主题支持，应能看到更细粒度高亮。

状态：需要 VS Code 人工验收。

### 2.11 Document Symbols / Workspace Symbols

验收步骤：

1. 打开 YAML 后按 `Ctrl+Shift+O`。
2. 在工作区按 `Ctrl+T` 或 `Ctrl+P` 后输入 `#` 搜索 symbol。

预期：

- 当前文档能列出 graph、state、node、transition 等符号。
- workspace 能搜索到 authoring symbol。

状态：需要 VS Code 人工验收。

### 2.12 空间字段 Picker

验收步骤：

1. 打开含空间字段的 YAML。
2. 光标放到 x/y、polygon、route、spawn、zone、entity 字段附近。
3. 执行对应命令：

```text
Game Authoring: Pick Spatial Field (auto-detect)
Game Authoring: Pick Map Position
Game Authoring: Edit Polygon
Game Authoring: Edit Patrol Route
Game Authoring: Pick Spawn Point
Game Authoring: Pick Zone
Game Authoring: Pick Entity
```

预期：

- auto-detect 能识别当前字段类型。
- Webview 中选择后写回当前 YAML。
- 写回后 diagnostics 不新增 error。

说明：

- 这是“写回当前光标字段”的能力，所以保留在 VS Code。
- 后续可加 code action 或快捷触发，让策划不用每次翻命令面板。

状态：需要 VS Code 人工验收。

## 三、当前 Warning 验收口径

当前 warning 类型：

- flag 有 reader 但没有 writer。
- flag 有 writer 但没有 reader。
- signal 有 listener 但没有 emitter。
- signal 有 emitter 但没有 listener。
- narrative state 未声明。
- pipeline authoring ID 与 legacy runtime ID 重名。
- 临时手测文件可能导致 runtime id collision，例如 `authoring/dialogues/1.yaml` 与 `authoring/narrative/1.yaml`。

验收标准：

- warning 不阻断构建。
- warning 必须能在 GUI `问题列表` 复制出来。
- warning 必须能在 GUI `关系诊断` 或源文件定位中解释。
- publish 前必须逐条确认 `ownership.legacyConflict` 是否符合预期。
