---
id: burn-workbench
title: 燃烧工作台(独立桌面应用 · 只编可燃物模板、和场景无关 · 页内跑同一份燃烧模拟与着色 · 模板唯一写入者)
domain: editor-tools
type: mechanism
summary: 可燃物模板（burnables/<id>.json：图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光）唯一的作者面与写入者，没有"先选场景"；原画视图是主视图（按真实尺寸在平面空间摆一个实例预览，火线速度就是准的）；「用在哪」只读列出所有宿主，点场景实体开只读场景视图（各实体按自己的 transform 摆、同一个模拟、左右点火站位与能不能站）；改名一次事务跟着改所有宿主上的 template 值（只动那几个值的字节、确认后被改过就拒绝、失败回滚），删除有引用就拒绝；页内预览打包运行时 burnSim / burnGeometry / burnAim / igniteStance / burnShadeParams 本体、着色拼 burnShade.glsl；推给游戏走联动协议 v2
status: active
authority:
  - tools/burn_workbench/store.py
  - tools/burn_workbench/serve.py
  - tools/burn_workbench/scenes.py
  - tools/burn_workbench/bundle.py
  - tools/burn_workbench/game_link.py
  - tools/burn_workbench/viewer/preview.js
  - tools/burn_workbench/viewer/render.js
  - tools/editor/shared/burnables.py
  - src/dev/runtimeBurnSync.ts
  - src/dev/runtimeBurnApiPlugin.ts
triggers:
  paths: ["tools/burn_workbench/**", "public/assets/data/burnables/**", "tools/editor/shared/burnables.py", "src/dev/runtimeBurnSync.ts", "src/dev/runtimeBurnApiPlugin.ts"]
  topics: [燃烧工作台, 可燃物模板, 真实尺寸, 握点, 燃料涂层, 顺序涂层, 着火点, 点火站位, 用在哪, 模板改名, 燃烧联动]
  tasks: [做可燃物模板, 配蜡烛, 配纸钱堆, 调燃烧表现, 看点火站位, 改名可燃物模板, 改燃烧工作台]
verified_by:
  - tools/burn_workbench/tests/test_store.py
  - tools/burn_workbench/tests/test_serve.py
  - tools/burn_workbench/tests/test_bundle.py
  - tools/burn_workbench/tests/test_selftest.py
  - tools/burn_workbench/viewer/tests/selftest.js
last_governed: 2026-09-23
---

## 是什么(一句话)

燃烧系统（[[burn-system]]）的作者面，玩法口径 `docs/玩法功能需求清单.md` A3.8「作者面」。**模板和场景没有任何关系**（制作人 2026-09-16：
"可燃物的编辑和场景有个鸡毛关系"）：谁用模板写在宿主自己身上（热点 / NPC 的 `burnable` 块归主编辑器场景页、挂件预设归挂件预设页、
轨迹 spawn 规格归动作编辑器、粒子薄片 `plate.burnable` 归粒子工作台），工作台一个都不写——只有模板改名时跟着改它们的 `template` 值。

启动 `sh scripts/py.sh -m tools.burn_workbench`（`--open <模板id>` 已开着就切过去；`--smoke` / `--selftest` / `--check` / `--bundle` / `--list` /
`--serve --port N` / `--game-url`）。单实例、桌面壳零缓存（`tools/desktop_shell.py`）。主编辑器只读显示、菜单「燃烧工作台…」打开
（与 [[vfx-workbench]]「主编辑器只是显示器」同一条规矩）。

## 权威源(读代码从哪进)

- 写盘：`store.py` —— 模板一律经 `tools/editor/shared/burnables.py` 闸门（`normalize_burnable`，`widthCm` / `heightCm` 必填）+ 原子写；
  内容没变不写；盘上被别处改过拒写。改名 `rename_plan` → `rename_asset(expect)`、删除 `delete_asset`、引用 `template_refs`（= 共享 `refs_of_template`）。
- 工程只读数据：`scenes.py`（「用在哪」加人话名字 `refs_detail`、只读场景视图 `scene_summary`（只列开了可燃的热点 / NPC + transform + 透视 / 朝向原始字段）、
  背景 / 行走面与深度壳、本地站位判定、玩家动画、带 igniter 的挂件预设、粒子效果、原画候选 `image_candidates`）。
- 页内运行时：`bundle.py` 把运行时模块打成 ESM（命名空间 = 文件名），缓存戳顺 import 扫整棵依赖树；`/gen/burnShade.glsl` 给着色原文。
- 页面：`viewer/core.js`（状态 / 撤销重做 / 脏态 / 对话框与选原画）、`preview.js`（模板预览 + 场景视图两份模拟、一条时间轴、站位、实体透视 / 朝向口径）、
  `render.js`（WebGL2 燃烧着色）、`views.js`（原画视图 / 只读场景视图 / 笔刷 / 着火点与握点）、`inspector.js`（含真实尺寸与握点）、`app.js`（左栏模板 + 用在哪、改名删除、联动）。
- 联动：`game_link.py` ↔ `src/dev/runtimeBurnSync.ts`（协议 v2：`runtime-burn` 工作台 → 游戏 `{writer, burnables?, probe?: {seq, action, target, socket?, point?}, walkProbe?}`；
  `runtime-burn-status` 游戏 → 工作台 `items: [{kind: scene|held, sceneId?, target, socket?, template, state, events, ready}]`）。

## 硬契约(违反即 bug)

- **没有场景绑定的编辑**：页面上没有场景选择、热点列表、布置编辑（initial / playerIgnite / 条件 / 信号都在宿主身上）、布置库。
  `burn_placements.json` 已删，全工具不读不写（`test_bundle.py` 钉着页面里不许出现旧名字）。场景视图**只读**：只能选中与点火，拖不动、改不了任何实体。
- **页面里不许有第二份模拟 / 摆放 / 站位 / 着色组装**：摆放 `burnGeometry.burnEntityPlacement` → `burnPlacementFrame`、尺寸 `burnables.burnableWorldSize`、
  着色参数 `burnShadeParams.burnShadeParamsOf`、材质与自发光 `burnShade.glsl` 的 `burnMaterial` / `burnGlowAdd`(游戏画的是 WGSL 孪生,工作台编 GLSL;两份一起改,`src/rendering/shaderTwins.test.ts` 逐函数守门)、火头伸到哪 `burnAim`、站位 `igniteStance`——
  全是运行时导出的同一份。`test_bundle.py::test_viewer_does_not_reimplement_the_sim` 钉着名字；包的依赖树里**不许有** `ignitePerformer.ts` / `types.ts`。
- **预览按真实尺寸**：原画视图的模板实例 = 平面空间（planar）+ `burnEntityPlacement({x:0,y:0}, 真实尺寸)`，同样的事件换一半尺寸烧得更快（自检钉着）。
  没有"假定尺寸 / 布置到热点上才准"这回事。预览风只在页面里（不写资源）。
- **只读场景视图的摆法照运行时实体本身**（`preview.js` 的 `entityPerspective` / `entityFacingLeft` / `entityPlacementOf`，口径出处写在注释里）：
  透视——热点 `Hotspot.setPerspectiveScale` 只有 `perspectiveScaleEnabled === true` 才吃、按 (x, y) 采样；NPC `Npc.setPerspectiveScale` =
  `perspectiveScaleEnabled ?? !renderRaw`、按接地点采样（锚点不在底中时迭代到不动点）。朝向——热点 `displayImage.facing`、NPC `initialFacing`。
  世界映射用场景载荷 field 空间，没有就 planar；风 = 场景 JSON 那份；`initial: burning` 的实例 0 秒点着（第一个着火点 / 整体）。
  当前模板用页面工作态，别的模板用各自的（打开过的也是工作态）。
- **燃烧着色只在"烧过"时挂**（状态 ≠ 没点，与游戏 `BurnRenderer` 同一条）：没点的消耗燃烧照挂的话顶上那一格按 0 秒火线发光（2026-09-16 抓到）。
- **真实尺寸**：`widthCm` / `heightCm` 必填 > 0（闸门硬拒；新建时按图的像素比例给初始值——场景里这张图写过展示宽度就按它换算、否则长边 50 cm——作者确认）。
  检视器缺省锁宽高比（改一边另一边按图像素比例跟，两位小数；锁是页面偏好）；与图宽高比偏离 > 2%（`store.ASPECT_TOLERANCE`）显眼提示——挂到手上的挂件是等比缩放、按宽算。
- **握点**：原画视图里拖（与着火点同一套交互），没写 = 底边中点、画成虚点；检视器可填 u / v、「清掉」删键；Delete 清选中的握点。
- **改名是一次事务**：先要求存盘 → `rename_plan` 列出会改哪些文件（每个几处）给作者确认 → `rename_asset(expect)`：
  确认之后那些文件（含模板文件本身）被别处改过、或多出了新的引用文件 ⇒ 拒绝并点名，一个字节不写；
  写的时候**只替换 `burnable.template` 那个 JSON 字符串值的字节**（`store.string_value_spans` 按路径找区间；文件是 ASCII 转义风格就照转义、CRLF 照留），
  写完逐文件核对"解析结果 == 原文只换这几处"；任何一步失败把写过的原字节写回、删新模板文件。做完清撤销栈。
- **删除**：还有任何宿主引用 ⇒ 拒绝并列出来（先去那些地方关掉可燃或换模板）；没有才删。
- **原画候选 = 校验器的媒体口径**：`public/resources/runtime` 下全部图（弹窗 + 筛选，已有模板在用的排前面），候选面 == 校验面。
- **数值保值**：闸门只收键序、硬拒坏形状，不改数值（盘上 `12.0` 存回去还是 `12.0`、int 不漂 float）；没写的字段显示缺省但不写回。
- **站位能不能站**：本地判定与游戏 `sceneDepthSystem.isCollision` 同一条反投影（`audit_walkable._scene_geometry`）+ 场景边界；
  游戏正好在该场景时发 `walkProbe` 以游戏结果为准（界面标来源）。
- **「在游戏里点着 / 熄灭 / 复原」从游戏回传的 items 里选用这份模板的实例**（场景实体 `target` = 实体 id；手上的 `target` = 拿着的人 + `socket`），不猜。
- **自检与 pytest 绝不碰真库**：读写全指到临时工程（`fixtures.py`），游戏地址钉死端口 `127.0.0.1:9`；`test_selftest.py` 核对真模板目录逐字节不变、
  真工程里不出现自检改名用的 id。
- **推给游戏 ≠ 导出到游戏**（命名口径见 [[sway-workbench]]「推给游戏 ≠ 导出到游戏」）：推 = 模板工作态进游戏内存；写资源只有 Ctrl+S（改名 / 删除另走各自的确认）。

## 已知坑

- **改名改的是别的工具的文件**：场景 JSON / `prop_presets.json` 归主编辑器、粒子效果归粒子工作台，它们各自可能开着内存副本。
  工作台这边靠"确认之后被改过就拒绝"保证不覆盖它们**已存盘**的改动；它们**没存盘**的改动工作台看不见——主编辑器的外部改动基线
  （`ProjectModel.detect_external_changes`，SHA-256）在下一次 Save All 要写这些文件时弹「检测到外部修改」让作者选：
  **选「继续保存」就把改名覆盖回旧 id**（`--check` 会报"引用处的模板不存在"），选取消 = 那边重新载入后再改；粒子工作台的保存基线
  直接拒存"效果已被外部修改"。确认弹窗里写明了这一点。
  工作台没法知道另一个进程里有没有没存的改动（没有跨进程锁），这是这条事务的边界。
- 顺序涂层第一笔之前按整张图的方向渐变打底；运行时按燃料包围盒归一化——开始涂顺序后底子与方向顺序有一点差（存下来的涂层两边一致）。
- 粒子画成源点、火光画成圈；场景视图的实例图平贴，没有深度遮挡与受光；场景视图只画开了可燃的实体（不画别的热点 / NPC）。
- 挂件贴图尺寸取当前状态第一张图（多帧不同尺寸时站位有偏差）。
- 改名要求先保存（弹「保存并继续」），做完清空撤销栈。「联动」默认勾着。
- Browser pane 隐藏时页面布局是 0 尺寸：在那里跑 `selftest.js` 读像素的几条会假红；以 Qt 无头自检为准。

## 怎么验证

`sh scripts/py.sh -m pytest tools/burn_workbench -p no:cacheprovider -q`（含页内自检 134 条）。
真数据：`sh scripts/py.sh -m tools.burn_workbench --check` 返回 0（模板形状 / 图在不在 / 粒子效果在不在 / 引用处的模板在不在 / 粒子薄片不许绑消耗燃烧）。
