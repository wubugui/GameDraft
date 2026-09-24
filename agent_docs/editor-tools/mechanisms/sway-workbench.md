---
id: sway-workbench
title: 草木工作台(抠植被 · 标刚体 · 推给游戏 / 导出到游戏)
domain: editor-tools
type: mechanism
summary: 背景草木拆层的作者面:自动分割打底 + 手涂四层(补植被 / 加刚体 / 减刚体 / 锁死)+ 锚点 / 整体摆 → sway_paint.png 与 sway_overrides.json 是烘焙的输入;推给游戏 = 页面此刻那份(存没存都算)烘进 local/ 预览、游戏原地换上、资源不动,导出到游戏 = 先存盘再烘进资源;烘焙只有 sway_field 一份,进程内按内容哈希缓存让推送约 1 秒;涂层是手工劳动,三道数据安全闸不许绕过;"✔ 已换上"要等游戏心跳确认
status: active
authority:
  - tools/sway_workbench/serve.py
  - tools/sway_workbench/layers.py
  - tools/sway_workbench/viewer/app.js
  - tools/character_lighting_lab/sway_field.py
  - src/rendering/backgroundSway.ts
  - src/dev/runtimeSwaySync.ts
  - src/dev/runtimeSwayApiPlugin.ts
triggers:
  paths: ["tools/sway_workbench/**", "tools/character_lighting_lab/sway_field.py", "src/dev/runtimeSway*"]
  topics: [草木工作台, 抠植被, 刚体, 竹子, 树干, 涂层, sway_paint, 拆层, 推给游戏, 导出到游戏, 草木预览, 锚点, 整体摆]
  tasks: [抠植被掩码, 标刚体部位, 推给游戏看草木, 导出草木拆层, 修草木抠错的地方]
verified_by:
  - tools/sway_workbench/tests/test_layers_and_serve.py
  - src/dev/runtimeSwaySync.test.ts
  - src/dev/runtimeSwayApi.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

分割认不出的东西作者自己画:`sh scripts/py.sh -m tools.sway_workbench`(主编辑器「工具 → 草木工作台…」、场景页「在草木工作台中打开…」、
开发控制台都有入口;命令行 `--push <场景>` / `--export <场景>`)。选场景 → 原画上涂 → **推给游戏**立刻看 → 满意了**导出到游戏**。
运行时见 [[background-sway]]。**游戏是预览器**:页面里不重跑摆动(那份数学只在 `backgroundSway.ts`)。

## 🔴 推给游戏 ≠ 导出到游戏(制作人 09-14 定名)

原话:"推给游戏是指立即推送给运行时的游戏!资源写游戏应该叫做导出到游戏"。起因:原「推给游戏」只让游戏重装盘上旧的拆层,
作者涂了保存按几百次都没变化,零报错。任何工作台新增推送 / 导出按钮都照这个语义,别造"重烘 / 同步"这种不说清写不写资源的名字。

| 按钮 | 读什么 | 写到哪 | 告诉游戏 |
|---|---|---|---|
| 推给游戏(P) | 页面此刻的四层 + 锚点 / 整体摆,**不先存盘** | `local/sway_preview/<场景>/…`(gitignore、不进包) | `{source:'preview'}` |
| 导出到游戏(B) | 盘上的涂层与逐株设置,**先存盘,没存上就不导** | 各时段 `lighting/<背景基名>/`(资源) | `{source:'export'}` |

烘焙是同一个 `sway_field.bake_sway`(给 `inputs` + `out_root` 就是推送)——**没有第二份拆层逻辑**。导出先落 `*.tmp`、全部时段烘完再一口气替换,
中途被杀资源里仍是上一整套;一个时段目录都没写就算失败。导出成功后本地预览退场。

## 作者面与三个通道(工作台与烘焙之间的契约)

`sway_paint.png` RGBA 一张、是**输入不是产物**(不进发行包):R 补植被 / G 锁死不动 / B 加刚体 / A 减刚体;刚体自动以分割出的木质打底,
`rigid = clamp(木质 + 加 − 减)`。通道次序两边各写一处(`layers.CHANNELS` 与 `sway_field.read_paint`),测试逐条钉死。
锚点 / 整体摆存 `sway_overrides.json`,**只存原画像素位置**(实例 id 每次烘焙都变),与涂层同一次 `Ctrl+S`、同一套撤销。
页面里四层各一张画布,存盘才合成(同一张画布叠画会跨层冲淡、橡皮擦掉别的层);橡皮 / 右键拖只擦当前层;撤销按一笔一张瓦片表存,带字节上限。

## 硬契约(违反即 bug)

- **🔴 `sway_paint.png` 只许一个写入者**(本台 + 走同一套历史的命令行 `--lock-ids`);旧 `sway_lock.png` 只剩读取 + 一次性迁移进 G 通道,
  谁也不许再产出它——两个来源就是"擦掉 → 保存 → 刷新又回来了"。
- **🔴 刚体度不许塞进 matte 的 alpha**(浏览器预乘清掉 RGB,自由度归零);**作者涂的刚体不参与"整株刚转"的判定**(会毁掉竿刚叶弯)。
- **🔴 推送不许落盘、不许写资源**(只许 `local/sway_preview/`,测试推前推后比资源指纹);导出前必须先落盘。
- **数据安全三道闸**(`layers.save_paint`,谁也别绕):乐观并发(盘上比装载时新就拒)/ 一次抹掉 > 35% 已有内容要点头 /
  每次保存留历史(文件名是被替换那份自己的存盘时刻,同字节不重复,历史目录必须在 `.dvcignore` 里)。恢复先读进内存再留当前那份。
  历史名必须是纯文件名(防拼路径)。草稿存服务端 `local/sway_drafts/`,**不许放 localStorage**(桌面壳纯内存 profile)。
- **保存只有一次在飞**;保存期间又画的笔不许被当成已存(按编辑序号判);没改不存。
- **🔴 缓存键只许是内容哈希**(不许文件名 / 时间戳 / 场景 id),缓存数组只读;换缓存时对着不缓存的旧产物逐位比过。推送 / 导出 / 预热共用一把锁。
- **推送 / 导出在线程里跑、前端轮询**(冷的时候十几秒,同步做就是"卡死的按钮");服务端只许一个活;响应里后台状态字段**不许叫 `ok`**(会盖掉信封)。
- **游戏侧**(`runtimeSwaySync.ts`):只认**本局启动之后**推的那行(槽文件跨重启留着);游戏只在 `scene:ready` 之后读槽,装场景期间心跳照发带 `loading`;
  重装 URL 必须带缓存戳 `?v=<rev>`(`AssetManager` 按 URL 缓存纹理)并丢掉上一份纹理;新 root 插回旧 root 的位置。
  **dev server 收下了 ≠ 游戏页看到了**:"✔ 已换上"要等心跳里 `applied >= rev`;装场景中的游戏页不许再开第二个游戏窗口。
  游戏在不在按推送用的那条槽**实探**(端口不止 5173),别拿控制台状态判。
- **切场景:全部读到才算切过去**(否则 `Ctrl+S` 把旧场景的涂层存进新场景名下);没有背景图的场景在下拉里标"装不了"。
  复用的大画布每次拿出来都要清空;着色缓存装场景时清掉。
- **单键快捷键遇到会吃字母键的控件要让开**(焦点在场景下拉上按 X 会清层、按 B 会导出);场景下拉走页内列表(`/vendor/dropdown.js`)。
- 写盘走 `retry_transient`([[atomic-write-windows]]);`.js` 的 MIME 自己钉死(Windows 注册表常映射成 text/plain,模块脚本被拒、页面白着)。
- 通知游戏与烘焙各一个 `try`(通知失败不能把烘好的活报成失败)。新增拆层产物要同步四处载荷镜像。

## 状态条要说出来的四档

涂了没存 / 推了没导出(游戏里是预览)/ 存了没导出(按导出时记下的输入内容指纹比,不只比 mtime)/ 游戏没收到。
预览与资源按内容指纹(涂层 + 逐株设置)与烘焙输入指纹(原画 / 照明烘焙变过)判新旧;没配风的场景直说"草木不会动"。
涂在没有实例的地方(石头、锁死区、空地)会被丢掉,烘焙报落在植被上的比例、低于一半出声。

## 怎么验证

- `sh scripts/py.sh -m pytest tools/sway_workbench/tests -q -p no:cacheprovider`(通道次序、三道安全闸、推送 / 导出各读什么写哪、预览路径两边一致、
  走缓存与清空缓存逐位相同——需要本机分割缓存,没有就跳过);游戏侧 `npx vitest run src/dev/runtimeSway`。
- `--smoke`(桌面壳起得来)、`--selftest`(无头桌面壳交互层:只擦当前层、撤销整笔、叠画不冲淡、装场景原画真画上……)。
- 端到端判据(09-13 跑马梁):涂三根竿 → 导出 → 游戏里刚体顶点两两相关 1.000、弯曲顶点只有 0.42 = 竿刚叶弯生效。
