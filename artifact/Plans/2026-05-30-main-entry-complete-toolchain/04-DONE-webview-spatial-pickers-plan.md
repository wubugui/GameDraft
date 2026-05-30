# VS Code Webview 空间字段 Picker 小计划

## 目标

把 VS Code Webview picker 从位置点选扩展到主要空间字段:authoring YAML 里的空间 ID 引用可以可视化选择,scene JSON 里的几何字段(polygon / patrol route)可以可视化编辑。

---

## 已确定的设计基线

- **D0 几何写回目标 = scene JSON**(`public/assets/scenes/*.json`)。
  几何数据(polygon / patrol route / spawnPoint / zone)当前只存在于 scene JSON,`authoring/` 下没有 scene YAML。因此:
  - 几何编辑器(polygon / route)读写 scene JSON 本身。
  - ID 选择器(spawn / zone / entity / scene)写回当前 authoring YAML 字段(ID 字符串)。
- **anchor picker 出范围**。项目无 anchor registry,最接近的是命名 `spawnPoints`,由 spawn 选择器顶替。实际 picker 收敛为 5 个:position(已有)、polygon、patrol route、spawn/zone/entity 选择器。
- **复用现有资产**(`tools/vscode-game-authoring/src/extension.ts`):
  `buildSceneSummary`(已解析 polygons/paths/markers)、`webviewHtml`(已渲染它们,只读)、`chooseScene`、`normalizeRuntimeAssetPath`、`nearestXYLines`、`lineIndent`、`formatCoord`、`keyContext`、`asObject/asArray/asNumber/asString`。核心增量是让渲染层可交互 + 写回结构化数据。

---

## 范围

本计划覆盖:

```text
1. polygon picker / editor(写回 scene JSON)。
2. patrol route picker(写回 scene JSON）。
3. spawn point picker（ID 写回 authoring YAML）。
4. zone picker（ID 写回 authoring YAML）。
5. entity picker（ID 写回 authoring YAML）。
6. 从当前 YAML 字段自动识别 picker 类型。
```

本计划不覆盖:

```text
1. anchor registry picker（无数据源，spawn 选择器顶替）。
2. graph reference view。
3. runtime trace timeline。
4. LSP rename / code action。
5. authoring YAML 内联几何字段写回（D0 下不触发，仅留接口）。
```

---

## 现状评估（关键约束）

```text
1. 扩展是单文件 ~1034 行。webview 已画 polygon/route/marker，但 pointer-events:none，纯只读。
2. 消息协议只有一条 postMessage({type:'picked'}) -> applyPickedPosition，
   只能写 scalar x/y 或插入片段，没有"替换整段序列 / JSON 数组"的能力。
3. 没有任何测试或测试脚手架（package.json 只有 compile/watch）。
```

---

## 前置依赖

```text
1. 现有地图点选 picker 可用（pickMapPosition）。
2. 可以从 YAML 光标位置解析字段 key（keyContext）。
3. 可以读取 scene JSON（buildSceneSummary 已解析空间字段）。
```

---

## 任务清单

### 阶段 0. 重构出可测纯函数层（前置）

把纯逻辑从 VS Code API 剥出到 `src/spatial/`，使阶段 1-4 可写 node 单测：

```text
1. src/spatial/fieldResolver.ts  -- resolveSpatialField(lineText, key, contextLines)。
2. src/spatial/yamlBlock.ts      -- findSequenceBlockRange / serializeSequence（T5 核心）。
3. src/spatial/sceneGeometry.ts  -- readPolygon/readRoute/writePolygon/writeRoute + 几何校验。
4. extension.ts 薄壳化，调用上述函数。
```

### T1. 字段到 picker 类型映射（阶段 1）

在 `fieldResolver.ts` 实现，复用 `keyContext` + 序列上下文探测：

```text
1. x / y / position            -> position picker（已有）。
2. polygon / collisionPolygon  -> polygon editor。
3. route（patrol 之下）        -> route picker。
4. spawnPoint / targetSpawnPoint -> spawn 选择器（ID）。
5. zone / zoneId               -> zone 选择器（ID）。
6. npc / entity / entityId     -> entity 选择器（ID）。
7. scene / sceneId / targetScene -> scene 选择器（ID）。
```

新增统一命令 `gamedraftAuthoring.pickSpatialField`：读光标 -> 解析 -> dispatch；
解析不到回退到 `pickMapPosition`。package.json 注册命令，可选加 editor/context 菜单。

### T2. Polygon picker / editor（阶段 2，写回 scene JSON）

```text
1. 新 webview 模式 mode:'polygonEdit'，传 targetSceneId + targetPolygonId + 初始点集。
2. 顶点拖动 / 点击边插入 / 删顶点 / 闭合预览，复用 clientToWorld、zoom/pan、snap。
3. 校验：点数 >= 3、自动闭合、可选自交警告（sceneGeometry.ts）。
4. 写回：postMessage({type:'polygonApply'}) -> 读 scene JSON -> writePolygon -> 写盘 -> 刷新文档。
```

### T3. Patrol route picker（阶段 3，写回 scene JSON）

```text
1. mode:'routeEdit'，传 targetSceneId + targetEntityId + route 点。
   注意：buildSceneSummary 给 route 前面塞了 entity 基点 [{baseX,baseY}, ...route]，写回时剔除基点。
2. 插入 / 删除 / 拖动 / 重排路径点；SVG 箭头显示方向。
3. 写回：writeRoute 写 npcs[id].patrol.route。
```

### T4. Spawn / Zone / Entity 选择器（阶段 4，ID 写回，优先做）

```text
1. 地图高亮候选 + 点击选择（契合空间语义），或 QuickPick + 高亮两形态。
2. 候选来源：spawn=spawnPoints keys + 默认 spawnPoint；zone=zones[].id；entity=npcs[].id + hotspots[].id。
3. 支持搜索 / 过滤；点击 -> postMessage({type:'idPick', key, value})。
4. 写回当前 YAML：range-based 替换光标行 key: 后的值。
5. 候选不存在 / 不可用 -> showWarningMessage 提示。
```

### T5. 统一写回协议（阶段 5，贯穿，最关键）

抽象 `WriteBackTarget` 分发器，取代散落在 applyPickedPosition 的逻辑：

```text
WriteBack =
  | { kind:'scalarXY' }                          // 现有 nearestXYLines 路径
  | { kind:'idValue', key, value }               // T4：替换 key: 后的值
  | { kind:'yamlSequence', keyLine, points }     // D0 下不触发，留接口
  | { kind:'sceneJson', sceneFile, jsonPath, value } // T2/T3：写 scene JSON
```

四条要求逐条落实：

```text
1. path-based edit：scene JSON 用 jsonPath（如 npcs/<idx>/patrol/route）定位；YAML idValue 用 key 定位。
2. range-based fallback：定位不到结构时回退选区/光标行替换（保留现有行为）。
3. 编辑前校验文档版本：打开 picker 记录 document.version / scene JSON mtime；
   apply 时重新从实时文档解析目标范围（不缓存旧 range），冲突则提示并回退剪贴板。
4. 写回后触发 diagnostics：YAML 写回调 refreshAuthoringDiagnostics；scene JSON 至少做 JSON parse 校验。
```

### 阶段 6. 测试与 smoke

```text
1. 纯函数单测：便携 node + node --test，覆盖 fieldResolver、yamlBlock（缩进/注释/尾项边界）、
   sceneGeometry（读写/校验/route 基点剔除）。不依赖 VS Code，可进 CI。
2. package.json 加 "test"；接入 09 的 CI 链。
3. 手测脚本 tools/vscode-game-authoring/SMOKE.md，以 teahouse 场景为样例。
```

---

## 输出物

```text
1. src/spatial/ 纯函数层（fieldResolver / yamlBlock / sceneGeometry）。
2. picker type resolver + pickSpatialField 命令。
3. polygon editor、patrol route editor（写回 scene JSON）。
4. spawn / zone / entity 选择器（ID 写回 YAML）。
5. 统一写回协议 WriteBackTarget。
6. picker 纯逻辑单测 + SMOKE.md 手测脚本。
```

---

## 验收标准

```text
1. 从 6 类 YAML 字段光标位置能各自解析出正确 picker 类型（单测含负例）。
2. polygon 可视化增删改顶点并写回 scene JSON，非法多边形被校验拦截。
3. patrol route 可视化编辑、方向可见，写回 patrol.route 不含基点。
4. spawn / zone / entity 能地图高亮 + 搜索 + 点击写回当前字段，无效目标有提示。
5. 三种写回路径命中正确位置；版本冲突安全回退；写回后 diagnostics 刷新。
```

---

## 风险点

```text
1. 字段 path 推断错误写错位置 -> apply 时实时重解析 + 版本校验 + 回退，不缓存旧 range。
2. 地图坐标系 vs YAML 坐标系 -> 现状均为世界坐标（scene worldWidth 空间），几何写回沿用，不引入变换。
3. 多 scene / 多 layer 候选过滤 -> 强制先 chooseScene，候选只来自该 scene；entity 按 npc/hotspot 分组。
4. scene JSON 是 legacy_editor 真源，与 Python 场景编辑器并发写竞争 -> 写前重读 mtime，外部已改则拒写提示。
5. BOM / 字段顺序 / 浮点格式（如 700.0）-> 用定点子树文本替换而非整体 JSON.stringify，
   否则 git diff 爆炸。这是 T5 落到 scene JSON 后的最大隐藏工作量。
```

---

## 建议实施顺序

```text
阶段0 重构纯函数层            — 基础，先做
阶段1 T1 解析器 + 阶段4 ID picker — 风险最低、价值最高，先交付
阶段5 写回协议（idValue 分支先行）
阶段2 polygon / 阶段3 route   — 依赖 scene JSON 定点写回（风险5），后做
阶段6 测试贯穿每阶段补

压缩选项：只交付阶段 0+1+4+5(idValue)，即纯 ID 选择器，
完全在 authoring YAML 内闭环、零跨文档风险；polygon/route 编辑器单独排下一期。
```
