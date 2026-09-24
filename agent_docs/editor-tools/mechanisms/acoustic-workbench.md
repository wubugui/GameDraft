---
id: acoustic-workbench
title: 声学工作台(独立桌面应用 · 场景 3D 展开 · 游戏只是预览器)
domain: editor-tools
type: mechanism
summary: 回音几何唯一的作者面与唯一写入者;把场景按深度在世界空间展开成 3D,反射面/听者/声源贴着画里的崖壁摆,Unity 式漫游与 gizmo;抽头与 IR import 运行时同一份打包;经 dev server 双槽实时推给游戏预览、试听在游戏里播且要有出声证据;M-world 是左手系,相机基按左手搭并有投影/对齐两类自证;--selftest 是交互层回归门
status: active
authority:
  - tools/acoustic_workbench/serve.py
  - tools/acoustic_workbench/spaces.py
  - tools/acoustic_workbench/bundle.py
  - tools/acoustic_workbench/game_link.py
  - tools/acoustic_workbench/viewer/app.js
  - tools/acoustic_workbench/viewer/view3d.js
  - tools/acoustic_workbench/viewer/mathx.js
  - tools/desktop_shell.py
triggers:
  paths: ["tools/acoustic_workbench/**", "public/assets/data/acoustic_spaces.json"]
  topics: [声学工作台, 回音, 反射面, 崖壁, 距离缩放, 3D 展开, 漫游, gizmo, 试听, 声学联动, 左手系, lookAt, 镜像]
  tasks: [摆回音, 改声学工作台, 加反射面类型, 改联动, 新空间, 改 3D 视图相机]
verified_by:
  - tools/acoustic_workbench/tests/test_spaces_and_serve.py
  - tools/acoustic_workbench/viewer/tests/selftest.js
  - src/audio/acousticSpacesData.test.ts
last_governed: 2026-09-23
---

## 是什么（一句话）

策划做一个场景的回音：开**声学工作台**（`sh scripts/py.sh -m tools.acoustic_workbench`；开发控制台工具栏、主编辑器
External tools、场景属性页 `acousticSpace` 旁的按钮都能进），选一个场景（按深度在世界空间展开成 3D），在画里的崖壁上
拖一段就是一面反射面，调吸收 / 粗糙 / **距离缩放**，按试听键游戏里立刻响，`Ctrl+S` 落 `acoustic_spaces.json`。
运行时那一半见 [scene-acoustics](../../runtime/mechanisms/scene-acoustics.md)。

**游戏只是预览器**（制作人 2026-09-08 定）：编辑与保存都在这里；游戏 F2 声学页只剩状态与试听。
脱离游戏也能编辑保存（抽头 / IR 本地照算），只是听不到、看不到真实听者。

**它是桌面应用**：入口是桌面窗口（`tools/desktop_shell`：纯内存 profile、NoCache、服务端 `no-store`）；`--serve` 只给自动化。
单实例；第二次 `--open <id>` 把已开着的窗口切到那个空间。

## 权威源（读代码从哪进）

`serve.py` = 路由与保存出口；`spaces.py` = 库读写、形状收束（`normalize_def`）、id 护栏、原子写 + `.bak`；
`bundle.py` = 用仓库自带的 rolldown 把运行时 `acousticSpace.ts` + `sceneSpace.ts` 打成 ESM（不入库，按源 mtime 缓存）；
`game_link.py` = 与游戏 dev server 两个槽位的代理 + 切场景命令入队 + 拉起游戏；
`viewer/app.js` = 文档 / 撤销 / 检视器 / 联动 / 保存；`viewer/view3d.js` = WebGL2 渲染、相机、拾取、gizmo（**文件头是完整手势表**）；
`viewer/mathx.js` = SceneCal、射线、`Geo`（反射面几何编辑纯函数）。场景 3D 几何直接 import 轨迹工作台的 `SceneGeometry`。

## 硬契约（违反即 bug）

- **本工作台是 `acoustic_spaces.json` 唯一的写入者**。主编辑器只读它做候选与校验；场景 JSON 里的绑定只有主编辑器写
  （被场景绑定着的空间拒绝改名）。
- **抽头 / IR 不在 JS 里镜像**：只 import 打出来的运行时包。打不出包（没 node）照常摆几何、存盘，页面明说"本地不显示抽头"。
- **发给游戏的就是校验过的落盘形**（发布前先 `normalize_def`），与游戏侧形状闸门同口径；v2 形状拒 `distanceScale ≤ 0`、
  端点重合、`height ≤ 0`、吸收 / 粗糙越界，整数不漂成 float。
- **只有真改了 doc 才标脏**；一次拖拽合成一条历史，纯点一下不算编辑；撤销 / 重做后重算 + 重发；检视器渲染只读。
- **保存锁 + 装载门**：保存在飞时又改了 doc，返回后不清脏；换场景期间遮罩 + inert、数据到齐一次性提交、序号作废旧装载。
- **听者绑定在这里设、一律写显式**（空间 `listenerBinding`；新建空间生来就是跟玩家）。场景 JSON 另设了 `acousticListener`
  时检视器黄字提示"游戏以场景的为准"。
- **抽头 / 直达按谁算要写明**：游戏在这个场景时按游戏里活的耳点算，否则按作者态听者。
- **试听要有出声证据**：序号由服务端发（页面刷新后从 0 数会被游戏当旧序号吞掉）；先看游戏回传"这次序号真起播了"，
  再看空间音总线的峰值——"播放函数返回了"不算。发布被拒时芯片红字，不被心跳冲掉。
- **拉起 / 切场景只在作者按了才动，不硬同步**：按钮按现状换脸（拉起 / 切过去 / 已在本场景）；游戏页在跑走命令队列
  （带 `targetBootId` 只指挥挑出来的那页），否则开**专用预览窗**（免手势音频、不后台降级、禁缓存，见
  [start-gate-audio-unlock](../../runtime/mechanisms/start-gate-audio-unlock.md)），再不行让开发控制台或自己起 dev server。
- **状态槽按页存**：多个游戏页同时回传时挑最新开的那页当"游戏"，其余列出来让人关掉。
- **3D 交互照 Unity 场景视图**，与轨迹工作台同一份手势表与相机基（两边各一份 `view3d.js`，**改一边要同步另一边**）：
  右键环视 + WASD 飞、Alt+左环绕、中键平移、滚轮朝光标缩放、F 对准、坐标架切正交、W/E/R gizmo + Ctrl 吸附；
  点只给移动 gizmo；小把手先于 gizmo 轴命中。

## 坐标：工作台的世界就是运行时的世界（不靠口头保证）

- **M-world 是左手系**（x 画面右、Y 上、**Z 进画**）。相机基按左手搭：`lookAt` 取 x = z × up，右 = up × forward。
  拿右手 lookAt 画它 = **整张画面左右镜像、手势全反，且不报错**（投影与拾取共用同一 mvp 所以自洽）——
  本工作台 09-08、轨迹工作台 09-10 各中一次。**预判到同病的第二处要当场改。**
- **两类自证都要能失败**：①投影判据——相机右向量投出去屏幕 x 变大、画里靠右的点 3D 里也靠右（自检 S1b）；
  ②对齐判据——把运行时 `sceneSpace` 打进页面原样跑，同一批画面点过运行时与工作台两套换算比 Δ（`checkAlignment`，
  镜像 / 错基 / 错尺都是几十上百 wu 的 Δ，场景芯片红字）。改相机基后要**变异一次**确认判据会红。
- **活证据**：游戏回传的听者带"画面点 + 它算的世界点"，左栏「游戏 · 坐标」行拿同一画面点过本地换算比（<5 wu 绿）。
- 透视场景里游戏的听者 `world` 是透视重整过的，画进 3D 必须用回传的 `worldOrtho`（见
  [audio-listener-space](../../runtime/mechanisms/audio-listener-space.md)）。

## 已知坑

- **`hidden` 属性压不过按 id 写的 `display:flex`**：两层遮罩曾从开页起就盖住画布，而 `el.hidden` 读出来照样是 true。
  页首 `[hidden]{display:none!important}` 兜底；自检看**算出来的** display 与 `elementFromPoint`，别只断言属性。
- **相机上向量别叫 `_up`**：mouseup 处理器已经是 `_up(e)`，class 里后定义的静默覆盖前者——叫 `_camUp`。
- **rAF 在隐藏页 / 无头壳里不跑**：飞行步进用定时器，别改回 rAF。浏览器面板隐藏时 `innerWidth` 为 0，拾取类自检一律走 `--selftest`。
- **自检里沿轴抓 gizmo 先用 `_hit` 核实**：端点 / ▲ 把手比轴优先命中，固定比例处恰好叠着把手就抓成别的手势。
- **把手命中结果的 `kind` 会被把手自己的 `kind` 盖掉**：`Object.assign` 顺序反了所有把手都拖不动。
- 对数滑条 step 会量化值，断言留一档容差；检视器别按序号取控件。
- `--selftest` 必须把游戏地址指到死端口：自检会往槽里发临时空间和试听，正在预览的人会听到。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/acoustic_workbench -q -p no:cacheprovider   # 库 / 服务 / 联动（假 vite）
sh scripts/py.sh -m tools.acoustic_workbench --selftest                        # 交互层（坐标对齐与手性、相机手势、gizmo、保存往返……）
npx vitest run src/audio src/dev                                               # 运行时尺度语义 / 同步规则 / 线上数据
```

改 viewer 先跑 `--selftest`，新抓到的坑往里加 `ok()`。真机联调：起游戏 dev + 工作台，看芯片"已套用 #N"、
游戏 F2 声学页联动行在收、3D 里出现绿色游戏听者。
