---
id: terrain-workbench
title: 地形工作台(碰撞 · 可走区 · 行走面修补 · 推给游戏 / 导出到游戏)
domain: editor-tools
type: mechanism
summary: 碰撞 / 可走区 / 行走面的唯一作者面:烘焙器只留自动结果(collision_auto.png),作者层(多边形 / 笔刷 / 高度增量)住 runtime/scenes/<id>/terrain/,唯一合成器 terrain_compose 把两者合成 collision.png + collision.json 旁挂 + 各时段 ground_d.png;推给游戏 = 页面此刻那份合成进 local/ 预览、游戏原地换上、资源不动,导出到游戏 = 先存盘再合成进资源;运行时对齐靠游戏用自己的 isCollision 答探测;文档一律网格单位(没乘 wu/q 的 M-world)
status: active
authority:
  - tools/character_lighting_lab/terrain_compose.py
  - tools/terrain_workbench/authoring.py
  - tools/terrain_workbench/serve.py
  - tools/terrain_workbench/viewer/app.js
  - tools/terrain_workbench/viewer/terrain_math.js
  - src/dev/runtimeTerrainSync.ts
  - src/dev/runtimeTerrainApiPlugin.ts
  - src/core/SceneDepthSystem.ts
  - tools/editor/shared/terrain_overlay.py
triggers:
  paths: ["tools/terrain_workbench/**", "tools/character_lighting_lab/terrain_compose.py", "src/dev/runtimeTerrain*", "tools/editor/shared/terrain_overlay.py", "tools/migrate_terrain_authoring.py"]
  topics: [地形工作台, 碰撞, 可走区, 行走面, collision.json, terrain.json, walk_brush, height_delta, ground_base, 推给游戏, 导出到游戏, 连通性, 运行时对齐]
  tasks: [改某个场景的碰撞, 补一条走不通的路, 修行走面高度, 导出碰撞到游戏, 查玩家为什么卡住, 重烘深度后作者层怎么办]
verified_by:
  - tools/character_lighting_lab/tests/test_terrain_compose.py
  - tools/terrain_workbench/tests/test_terrain_workbench.py
  - tools/terrain_workbench/tests/test_art_review.py
  - tools/terrain_workbench/tests/test_selftest.py
  - tools/editor/tests/test_scene_terrain_overlay.py
  - src/dev/runtimeTerrainSync.test.ts
  - src/dev/runtimeTerrainApi.test.ts
last_governed: 2026-09-14
---

## 是什么(一句话)

碰撞 / 可走区 / 行走面修补**全在地形工作台里做**(制作人 2026-09-14 定):开 `sh scripts/py.sh -m tools.terrain_workbench`
(主编辑器「工具 → 地形工作台…」、场景页「地形 / 碰撞 → 在地形工作台中打开…」、开发控制台「地形工作台」),
选场景 → 在 3D 伪世界 / 原画上画可走 / 阻挡多边形、涂笔刷、雕行走面 → **推给游戏**(立刻在跑着的游戏里原地换上,资源不动)
→ 满意了 **导出到游戏**(写进资源)。主编辑器对地形**只显示**(场景页只读块 + 画布红块)。
agent 批量 / 照原画修碰撞走同一作者层的命令行面 `tools.terrain_workbench.art_review`,方法见
[collision-from-art](../recipes/collision-from-art.md)(圈可走集、其余自动封死、摆人复查)。

## 数据(三层,一个合成器)

    烘焙器的自动结果(auto)  ⊕  作者层(笔刷 / 多边形 / 高度增量)  →  游戏读的产物

| 层 | 文件 | 谁写 |
|---|---|---|
| 自动结果 | `runtime/scenes/<id>/terrain/collision_auto.png` + `terrain.json.auto`(网格 / sha1 / 烘焙时间) | 烘焙器 `pipeline.export_scene_depth` → `terrain_compose.record_auto` |
| 作者层 | `terrain/terrain.json`(grid / regions / heightOps / brush / height 引用)、`walk_brush.png`(0 自动 / 1 可走 / 2 阻挡)、`height_delta.png`(RG16 有符号,量程记在 `height.range`) | **只有地形工作台** |
| 行走面基底 | 各时段 `lighting/<背景基名>/ground_base.png` + `lighting.json.ground_base` | 烘焙器导出行走面时留下(`record_ground_base`);老载荷首次修补前 `ensure_ground_base` 把现在的 ground_d 当基底 |
| 游戏读的 | `collision.png` + **`collision.json` 旁挂**(网格原点 / 格大小 / 宽高 / 合成出处)、各时段 `ground_d.png` | `terrain_compose.export_terrain`(烘焙器导出 / 工作台推送 / 导出三条路都是它) |

- **合成规则**:`可走 = (自动可走 ∪ 笔刷可走 ∪ 多边形可走) − (笔刷阻挡 ∪ 多边形阻挡)`——阻挡压过可走,与顺序无关;自动网格外 = 可走
  (运行时"没数据"的语义)。行走面:`Y = Y基底 + Δ`,Δ = 高度增量栅格(双线性)+ 多边形操作(压平到某高度 / 整块抬高,解析羽化),
  合成后**对每条屏幕射线从前往后扫再二分**写回 `ground_d.png`(第一次落到面下 = 可见表面,台阶的立面像素落在立面上);Δ 恒 0 的像素逐字节不动。
- **🔴 单位**:文档里一切坐标都是**网格单位** = 运行时 `isCollision` 里没乘 `wuPerQUnit` 的 M-world(`collision.json` 的 `cell_size` 典型 0.0285 ≈ 8～25 wu)。
  页面按 wu 显示(`S.k = SceneCal.wuPerQ`),存盘时除回去;Python 合成器 `make_delta_fn(..., k)` 在两种单位间换。混用零报错、只是落错格。
- **运行时**:`SceneDepthSystem.load` 先读 `collision.json` 旁挂,没有才退回 `depthConfig.collision`(老场景);位图尺寸 ≠ 声明 ⇒ **整份拒用并出声**。
  场景 JSON 从此不再含 `collision` 块(`tools/migrate_terrain_authoring.py` 2026-09-14 搬过一次:35 场;实验室的屏幕笔刷层
  `out/<场景>/<bg>/collision_edit.png` 走运行时反投影链落成世界笔刷层,源文件改名 `*.migrated.png`)。
- **重烘深度之后**:烘焙器只覆盖 `auto` 与 `ground_base`,作者层原样叠回去(`export_terrain` 在导出末尾跑)。
  这**只在几何没变时成立**(同一套标定重烘)。
- **🔴 重做深度(换标定 / 换俯角 / 深度重新拟合)时作者层会整片错位,而且不报错**:作者多边形存的是网格点,
  几何一变同一个网格点就落到画面别处;合成器还沿用旧的网格声明。画面上哪里是路不随深度变,所以按**画面轮廓**重投:
  重烘前 `python -m tools.terrain_workbench.art_review pin-screen <场景>`(把每块的画面轮廓钉进 `screen.points`,
  工作台里手画 / 拖过的按当前几何反投补上);导出深度后 `... art_review reanchor <场景>`(网格换成新自动结果那套、
  每块按轮廓重新落格、外围块重算、导出、`grid --fit`)。笔刷层 / 高度修补是栅格没有轮廓,`reanchor` 遇到就停。
  2026-09-25 崖墓前段 / 前段1 / 后段改立面约束标定时首用(见 [[scene-bake-downstream]] ④)。

## 作者面有什么(Unity 式,与另外四台同一套手势)

| 做什么 | 怎么做 |
|---|---|
| 看 | `1` 3D(右键环视 + WASD 飞、Alt+左键环绕、中键平移、滚轮朝光标缩放、F 对准、Home 整场、右上角坐标架)· `2` 原画 · `3` 顶视(正交) |
| 画区域 | `P` 可走多边形 / `Shift+P` 阻挡:逐点点击,双击 / Enter 闭合,右键 / Backspace 退一点,Esc 取消;`Shift+B` 拉阻挡矩形(可走矩形在工具栏);画完自动回选择 |
| 改区域 | `V` 选择:点顶点 / 点区域内部;**选中立刻出 gizmo**(与轨迹台共用 `/vendor/gizmo.js`,W 移动 / E 旋转 / R 缩放、Ctrl 吸附);双击边线插点;Delete / 右键点顶点删点;右栏改种类 / id |
| 笔刷 | `K`:可走 / 阻挡 / 擦(回自动);`[` `]` 或 Shift+滚轮改半径;按住拖是连续笔画(一笔一条历史);右键点一下 = 擦 |
| 行走面 | `H`:雕刻笔刷(抬 / 压 / 平滑 / 压平到)或高度多边形(压平到某高度 / 整块抬高 + 羽化);**不即时**重算行走面(推给游戏 / 导出时算),图上蓝色标改过的格 |
| 检视 | `I` 点一格:谁决定的(自动 / 笔刷 / 多边形)、走不走得到、高度增量、世界 / 画面坐标 |
| 连通性 | 每次改动即时 flood:**每个出生点**都要走得到每个出口 / 跨点站位、落点必须可走;走不到的可走格染黄;左栏一行一条,点一下对准 |
| 撤销 / 草稿 / 历史 | Ctrl+Z / Y(整份快照);每 8 s 存草稿到 `local/terrain_drafts/`(重开问要不要恢复);每次保存前留一份到 `terrain/history/`(.dvcignore) |
| 保存 | Ctrl+S:只写作者层;乐观并发(盘上被别处改过要点头) |
| **推给游戏** | 按钮 / Ctrl+Enter:页面**此刻**的工作态(存没存都算)合成进 `local/terrain_preview/<场景>/`,游戏原地换碰撞 + 行走面;**资源不动** |
| **导出到游戏** | `B` / 按钮:先保存,再合成进资源(`collision.png` / `collision.json` / 各时段 `ground_d.png`),游戏换回资源;导出后跑连通性审计报到日志 |
| **运行时对齐** | 顶栏芯片:工作台挑一批格心投成画面点写进槽,**游戏用自己的 `isCollision` 判**并回 0/1 串,逐点比——不是页面里抄公式 |

命令行:`--list` / `--check [id]`(形状 + 磁盘一致 + 连通性)/ `--push <id>` / `--export <id>` / `--selftest`。

## 🔴 推给游戏 ≠ 导出到游戏(制作人定名,与草木台同一条)

- 槽 `/__gamedraft-api/runtime-terrain`(`src/dev/runtimeTerrainApiPlugin.ts`):一行 `{rev, sceneId, source, ts}` + `probe`;预览口
  `<槽>/preview/<场景>/collision.{png,json}`、`<槽>/preview/<场景>/ground/<烘焙目录>/ground_d.{png,json}`(只认这几个文件名,Python `PREVIEW_FILES` 同一份,测试对着断言)。
- 游戏侧 `runtimeTerrainSync.ts`:**这一局里新来的**推送才算;`preview` 记下"这个场景用预览",`export` 忘掉;进场景装载完
  (`characterLighting.onReady`)若这一局推过这个场景,按缓存戳再原地换一次(AssetManager 按 URL 缓存,不换 URL 永远是旧图)。
- `Game.reloadTerrainInPlace`:`SceneDepthSystem.replaceCollision`(位图 + 旁挂 + 影子裁切纹理)+ `CharacterLightingSystem.replaceGround`
  (尺寸 ≠ work 整张拒用)→ 深度系统地面场 / 玩家碰撞闭包 / 听者 / 粒子空间 / F2 可视化逐个拨一遍,与载荷落地那段同序。

## 主编辑器只显示

场景页「地形 / 碰撞」块(`tools/editor/shared/terrain_overlay.py`):网格 / 阻挡比例 / 作者层摘要 / 待导出;画布红块 = 按游戏读的
`collision.png` **走运行时那条反投影链**投到画面上(纯显示,空 shape 不吃鼠标)。地形工作台退出 / 主窗回前台自动重读。

## 别再犯

- 别在页面里另写一份合成 / 反投影"近似":页面的 `terrain_math.js` 是 Python 合成器的镜像,自检 S2 与 pytest 的 JsParityTests 逐格对账;运行时对齐只信游戏自己答的。
- 别把 wu 写进文档(见单位一条)。
- 别让烘焙器碰作者层:它只写 `auto` 与 `ground_base`。
- 别再造第二个碰撞产出口:`collision.png` / `collision.json` / `ground_d.png` 只从 `export_terrain` 出来;实验室 `/api/save_edit?kind=collision` 已 410。
