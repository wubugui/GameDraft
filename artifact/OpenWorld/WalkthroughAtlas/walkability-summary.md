# 攻略地图可达性验证 · 2026-09-06

结论：攻略涉及的关键路线与站位 **部分通过**。9 场景 92 个目标的运行时碰撞查询中，91 个能进入交互半径；实际用玩家移动命令走到 35 个不同目标并核对正确交互提示，7 次跨场景出口实际按 E 通过。本报告验证地图和站位，不代表 25 项任务全流程通关。

完整坐标、折线、实际终点、提示、失败尝试和复现起点见 `walkability-report.json`。`scenes[].targets[].route` 是 A* 几何折线；`actual[]` 是真实移动输入记录，两者不可混作相同证据。`confirmedTargets[]` 给制图用的已确认站位。

## 攻略必须写清的入口和站位

- 新页进入“开放雾津”后实测时间是 **11:00 午时**。街头歇脚点按 E，选择“歇到辰时开市”，实测变为次日 **07:00 辰时**。随后码头周三确实出现。不能把地图中的早班人物当作新页开场人物。
- 后巷纸扎工作台实体在 `(1000,565)`，中心有碰撞。从罗伯处先绕 `(995,481) → (971,481) → (963,513) → (963,555)`；实测站 `(962.74,556.16)` 才得到工作台提示。在北侧 `(977,528)` 会先选到“歇脚”。
- 桥下去河滩出口实测站 `(2980.5,2007.3)`。在 `(2947,1938)` 会先交互桥头旧木桩，需要继续往右下走。
- 正殿灰盘架站 `(511.32,374.98)` 交互；物件中心 `(530,380)` 在碰撞后方。功德簿站 `(328,375)`。
- 庙前灰盘 `(868,677)`、侧门木闩 `(606,489)`、迎风口 `(646,489)`、进正殿 `(680,519)` 均实走到正确提示。

## 实际按 E 通过的出口

1. 雾津街头左下后巷入口 → 后巷 `from_wujin`。
2. 码头河埠 → 桥下 `from_street`。
3. 桥下右岸 → 河边 `ow_from_bridge`。
4. 河边高石阶 → 雾津街头 `from_river`。
5. 山路上石阶 → 庙前院 `from_mountain_pass`。
6. 庙前院 → 正殿 `from_street`。
7. 正殿 → 庙前院 `spawn_0`。

桥下低岸和河边高石阶以上结果是在普通位面验证。背尸位面的修岸/修阶条件未在本次通过，不能据此宣称背尸路线已验证。

## 未通过与范围外风险

- 茶馆 `ow_luo` `(268.1,225.22)`：从门口出生点无法走入其 95 单位交互范围；细化至 2 单位网格仍无路，扩大到 105 才有路径。本次时相该 NPC 隐藏，未做出现后的 E 验证。主攻略在后巷找罗伯，避开这个替代地点。
- 后巷旧 `from_a` 出生点落在碰撞内；当前两个街头入口都使用有效的 `from_wujin`，不影响所写路线。
- 正殿旧 `spawn_0` 与正常入口的行走区域在采样网格上不连通；当前进门使用 `from_street`，不影响所写路线。
- `playerMoveTo` 仅八向追点，长斜线可能切墙。重复寻路或分段后能走通的情况在记录里保留为驾驶方法问题，未当作游戏死路。
- 固定 tick 模式下，歇脚后第一次等待换相超时是驾驶员少泵了 pending phase 的帧；补 5 个正常 tick 后换相完成，属于驱动问题。

## 隔离与清理

使用独立 Chrome 无头 context 和 5174 服务；本页屏蔽命令队列读取以及全部开发 API 写请求，操作只在本页调用命令，未访问用户 5173 页面/存档。没有请求或下载任何 OSS 对象。验证结束已关闭自己的浏览器和 5184 驾驶员服务，根代理的 5174 服务保持运行。

## 换电脑复现驾驶会话

先用项目 preview 启动配置 `game-dev-5174` 启动开发服务。以下 PowerShell 命令只启动隔离浏览器驾驶员，不启动 Vite，也不下载浏览器、包或 OSS 资源。将 Playwright 目录和 Chrome 路径替换为新电脑上已有的位置：

```powershell
$env:ATLAS_PLAYWRIGHT = 'D:\tools\node_modules\playwright'
$env:ATLAS_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:ATLAS_GAME_URL = 'http://127.0.0.1:5174/'
$env:ATLAS_DRIVER_PORT = '5184'
node artifact/OpenWorld/WalkthroughAtlas/walkability-driver.mjs
```

- `ATLAS_PLAYWRIGHT` 指向包含 `index.mjs` 的已安装 Playwright 包目录；不设时使用 Node 常规 `playwright` 包解析，不再绑定任何本机用户目录。
- `ATLAS_CHROME` 可覆盖浏览器可执行文件路径；默认是上例 Windows Chrome 路径。
- `ATLAS_GAME_URL` 默认 `http://127.0.0.1:5174/`；缺少查询参数时补上 `mode=dev`、`ndbg=0`、`narrativeWarp=开放雾津`，保留显式参数。
- `ATLAS_DRIVER_PORT` 默认 `5184`，只监听 `127.0.0.1`。

在另一终端读取隔离页面玩家状态：

```powershell
$body = @{ code = '() => ow.brief()' } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5184/eval -Body $body -ContentType 'application/json'
```

这提供复验驾驶入口；35 个目标的历史逐点移动与 7 次切场证据保存在 JSON 中，脚本启动本身不会自动重跑全部记录。完成后仅关闭本驾驶员：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5184/close -Body '{}' -ContentType 'application/json'
```
