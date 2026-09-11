# 声学工作台（acoustic_workbench）

场景回音几何的**唯一作者面与唯一写入者**。把一个场景按深度在世界空间展开成 3D，反射面（崖壁 /
水面 / 岩檐）、听者、声源以 3D 物体的形式直接摆在画里的崖壁上，像 Unity 那样漫游与操作；
每动一下**游戏下一拍就重算 IR**，试听也是经通道让游戏播。游戏运行时只是预览器。

```bash
sh scripts/py.sh -m tools.acoustic_workbench                 # 桌面应用（缺省）
sh scripts/py.sh -m tools.acoustic_workbench --open 山谷_大   # 直接打开某个空间（已开着就切过去）
sh scripts/py.sh -m tools.acoustic_workbench --serve         # 裸服务 http://127.0.0.1:5331（自动化用，不开浏览器）
sh scripts/py.sh -m tools.acoustic_workbench --game-url http://127.0.0.1:5191   # 指定游戏 dev server
sh scripts/py.sh -m tools.acoustic_workbench --selftest      # 交互层端到端回归（无头真页面）
sh scripts/py.sh -m tools.acoustic_workbench --list
```

入口：开发控制台（`tools.dev_console`）工具栏「声学工作台」；主编辑器菜单「External tools → 声学工作台…」，
场景属性页 `acousticSpace` 旁「在声学工作台中打开…」；`./dev.sh acoustic-workbench`（POSIX 机）。

**一键拉起游戏进本场景**（顶栏「▶ 拉起游戏进本场景」）：游戏页已在跑 → 走运行时命令队列切场景；
dev server 在跑但没开页 → 浏览器打开 `?mode=dev&devScene=<场景>`；什么都没有 → 让开发控制台起游戏服务并开页
（控制台没开就工作台自己起 `tools.dev game start`，端口通了再开页）。起来后联动自动接上，地址栏自动跟。

## 操作（像 Unity）

| | |
|---|---|
| 右键拖 | 环视（机位不动转头）；按着右键时 WASD/QE 飞行，Shift ×3，滚轮调飞行速度 |
| Alt+左键 / 中键（或空格+左键）/ 滚轮 / Alt+右键 | 绕目标点环绕 / 平移 / 朝光标缩放（光标下的点不动）/ 推拉 |
| F / Home / 双击物体 | 对准选中 / 看全景 / 选中并对准它 |
| 右上角坐标架 | 点 X/Y/Z 臂 = 从那一侧正交看（顶视 / 侧视摆面）；点中心 = 透视 ⇄ 正交 |
| Q / W / E / R | 选择 / 移动 / 旋转 / 缩放 —— 选中物上出现 Unity 式 gizmo：箭头沿轴、小方块沿面、中心贴地挪；绿环绕竖直轴；轴末端单轴缩放（Y = 面高）、中心等比；按住 Ctrl 吸附（10 wu / 15° / ×0.1） |
| B | 加崖壁：在画里的崖壁或地面上按下、拖到另一点松手（端点吸附到深度壳或地面） |
| N / L / P | 加水平面（在地面上拖一条边）/ 放听者（点地面）/ 放声源（点地面） |
| 拖端点 A/B、▲ | 改形状 / 面高（单选一面时；高程、移动、旋转、缩放都走 gizmo） |
| Shift+点、左键空白拖框 | 多选；Delete 删；Ctrl+D 复制；方向键微移；Ctrl+Z/Y 撤销重做；Ctrl+S 保存 |

右栏：检视器（吸收 / 粗糙 / 高程 / **距离缩放** / 耳高 / 尾巴 / 立体宽 / 遮挡）、抽头表、IR 波形、
每条试听干声放不放得下的提示。左栏：反射面清单（离听者距离 / 首回）、图层、游戏回传的状态。

## 数据（v2）

`public/assets/data/acoustic_spaces.json`，几何一律 **M-world wu**（原点画面中心、Y 朝上、XZ 地面，
与灯位 / 轨迹同一坐标系）。计算时 `米 = wu / 88 × distanceScale`：反射面贴着画里的崖壁摆，再用
**距离缩放**把整个空间等比放大——面积/L² 是尺度不变量，所以缩放只改延迟与空气吸收，不改强度。
`authoring.sceneId` 记它在哪个场景里摆的：逻辑上一份场景几何一个空间，强绑到别的场景只是不保证效果对。

抽头 / IR 不在 JS 里镜像：`bundle.py` 用仓库自带的 rolldown 把运行时 `src/audio/acousticSpace.ts`
打成 ESM（`viewer/_gen/`，不入库），页面 import 同一份实现。

**坐标与运行时对齐，不靠口头保证。** M-world 是左手系（x 画面右、Y 上、Z 进画），3D 相机按左手系搭
（右手 lookAt 画它整张画面镜像、左右操作全反且不报错——第一版就是）。`bundle.py` 把运行时
`src/utils/sceneSpace.ts` 一并打进包，页面装完场景跑一道自证：同一批画面点 / 出生点 / NPC 分别过运行时
`groundWorldAt` 与工作台自己的换算，网格顶点经运行时 `worldToScene` 投回画面对 uv；对不上场景芯片红字。
连着游戏时左栏「游戏 · 坐标」行再拿游戏回传的听者画面点比一次它自己算的世界点。

**声源有位置，听者只有一个（v3）。** `P` 点地面放声源（可放多个），选中哪个声源试听就从它发出（选听者 = 自己喊）；
抽头 / 直达按游戏里活的听者算（游戏在这个场景时），表头写明按谁算。听者绑定（跟玩家 / 相机 / NPC / 钉在作者点）
在左栏「听者」里设，写进空间 `listenerBinding`；脚步、试听、回音在游戏里共用这一个听者。「直达声」一节调
参考距离 / 衰减 / 最远 / 声像宽（声学米），脚步与 NPC 同一套参数。试听按下后看状态栏：先看游戏是否真起播（序号），
再看空间音总线的输出峰值——BGM 冒充不了。

**游戏页开在专用预览窗，打开就有声、一直有声。** 顶栏按钮按现状换脸：没游戏「▶ 拉起游戏进本场景」、游戏在别的场景
「⇄ 游戏切到本场景」（按了才切，不自动跟）、已在本场景灰掉。开页走 `tools/dev/game_preview.py`：本机 Chrome/Edge 的专用实例
（免手势音频、没焦点 / 被盖住不降级、不缓存）。游戏页跑在普通浏览器里时顶栏露出「⧉ 专用窗重开」。几个游戏页同时回传时
工作台认最新开的那页，其余列在「游戏」面板让你关掉。

## 与游戏的联动

走游戏 dev server（vite）上的两个文件槽（`src/dev/runtimeAcousticsSync.ts` 与 `vite.config.ts`
的 `runtimeAcousticsApi`）：工作台 → 游戏发空间定义 + 试听序号；游戏 → 工作台回传场景 / 听者 /
抽头 / 耗时 / 音频是否解锁。页面经本工具的 Python 服务代理（`game_link.py`，vite 那两条中间件没有
CORS）。游戏地址：`--game-url` > 根目录 `devstate.json` 的 `gameUrl` > `127.0.0.1:5173`。

游戏没起也能编辑保存，只是听不到、看不到真实听者。

## 验证

```bash
sh scripts/py.sh -m pytest tools/acoustic_workbench -q -p no:cacheprovider   # 库读写 / 服务 / 联动（假 vite）
sh scripts/py.sh -m tools.acoustic_workbench --selftest                        # 交互层：加墙 / 拖把手 / 撤销 / 保存往返 / 键盘 / 换场景
npx vitest run src/audio src/dev                                               # 运行时：v2 尺度语义 / 同步规则 / 线上数据
```
