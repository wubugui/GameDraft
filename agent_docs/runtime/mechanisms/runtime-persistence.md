---
id: runtime-persistence
title: 运行时持久化(存档/玩家设置)落文件,不落浏览器存储
domain: runtime
type: mechanism
summary: 存档与玩家偏好一律经 PersistentStore 落本地文件;三后端 Tauri>dev server>内存;localStorage 只剩一次性迁移读取;内存降级必须让 UI 说实话
status: active
authority:
  - src/core/storage/persistentStore.ts
  - vite.config.ts#persistentStoreApi
  - src-tauri/src/gamedata.rs
triggers:
  paths: ["src/core/storage/**", "src/core/SaveManager.ts", "src/core/TextDisplaySettings.ts", "src-tauri/src/gamedata.rs", "vite.config.ts"]
  topics: [存档, 玩家设置, 持久化, localStorage, origin, PersistentStore, Tauri, gamedata]
  tasks: [加玩家偏好, 改存档, 接打包壳]
last_governed: 2026-08-28
---

## 是什么(一句话)

**玩家可见的持久化(存档、文字显示设置)一律经 `PersistentStore` 落本地文件**;
开发期由 dev server 中间件写仓库 `local/gamedata/`,打包后由 Tauri 的 Rust 侧写 exe 旁
`gamedata/`。两边**同一套 JSON 格式与目录语义**,档案可以直接互拷。

## 权威源(读代码从哪进)

接口与后端选择:`src/core/storage/persistentStore.ts`(`resolvePersistentStore`)。
开发期后端:`vite.config.ts` 的 `persistentStoreApi`。打包侧后端:`src-tauri/src/gamedata.rs`。

## 为什么不用 localStorage(2026-08-28 拍板)

`localStorage` 按 **origin** 隔离,而这个游戏会在**三种壳**里跑:编辑器内嵌 QtWebEngine、
外部浏览器、打包后的 Tauri exe。三者是**物理上互不相通**的存储——同 origin 也不共享。
真实故障:编辑器里存的档,用浏览器打开就"消失"了(数据一直在,只是躺在另一个仓)。

2026-08-27 的 `0c8341e` 把 dev server 统一绑 `127.0.0.1` 来治这个,但那只解决了
**同一个浏览器内部** `localhost` 与 `127.0.0.1` 分家,解决不了**编辑器 WebEngine ↔ 外部浏览器**
——那是两个浏览器。改成文件后根因才真正消失。

> 与 [debug-ui-persistence](debug-ui-persistence.md) 的分工:那张卡管**调试/编辑器**偏好
> (落 `resources/editor_projects/editor_data/`,运行时永不加载);本卡管**玩家**的东西
> (落 `local/gamedata/`,是这台机器上这一份进度,不是工程数据)。两个存放面不要混。

## 硬契约

- **三后端,按可用性挑**:Tauri > dev server(HTTP) > 内存。探测 dev server 是**真发一次请求**,
  不看 `import.meta.env.DEV`——构建产物也可能被静态服务器托着跑,那时中间件并不存在。
- **内存降级必须让 UI 说实话**。`store.persisted === false` 时入口卫兵挂红色横幅
  「本次进度不会被保存」。以前这件事是**静默**的:玩家存完档、关掉、回来发现没了。
- **`namespace` / `key` 只允许 `[A-Za-z0-9_-]`**,前端与 Rust 侧**各校验一次**。
  它们会变成目录名与文件名,拼路径的地方不校验 = 把路径穿越交给调用方。
- **写文件先写临时文件再原子改名**(Rust 侧)。直接覆写时写到一半掉电,玩家拿到的是
  一个被截断的存档——比没存上更糟,因为它看起来存在。
- **旧档迁移是复制不是搬运**:从 localStorage 读上来后**不删原件**。
  文件侧已有档时**绝不**被旧档盖掉(否则玩家删过的档会借迁移复活)。
- **迁移标记写在 localStorage 一侧,不是文件侧。** 直觉上该写文件侧,但那样是错的:
  文件侧的标记躺在 `local/gamedata/`,而 `local/` 是 gitignore 的每机状态——换个 worktree、
  清一次 `local/`,标记就没了,于是三个远古浏览器档**每次都会**被重新灌回来。
  标记必须跟着**来源**走。这是运行时唯一一处 localStorage **写入**,纯记账、写一次。
- **同一个键的写入要串行。** 快速连存同一槽(脚本 / 命令通道 / 手快)时两个写请求并发出去、
  到达顺序不保证:磁盘可能留下先发的那份而镜像被后 resolve 的那份覆盖,表现是
  "重启后存档回退了一步",极难复现。镜像的更新也要放在同一条链里。
- **删除失败不动镜像**,与写失败同一道理:镜像已删而磁盘还在,重启后档会"复活",
  玩家会以为删除坏了、或者更糟——以为自己删错了。
- 新增一类玩家偏好:加一个 `settings` 命名空间下的键,照 `TextDisplaySettings` 的
  `hydrate()` + 即发即走 `persist()` 范式写。**偏好写失败只记日志**(拖个滑条不该弹错误框),
  **存档写失败必须回报**——两者诚实度要求不同。

## 已知坑

- 构造函数里读不了盘。所有用到偏好的类都是「构造期立缺省值 → `start()` 里 await `hydrate()`」,
  水化必须排在**任何读这些值的 UI 构造之前**。
- 打包产物用静态服务器托管(没有 Tauri、没有 dev server)时会走内存后端,这是预期行为;
  验收产物时看到那条红横幅是**对的**,不是 bug。

## 怎么验证

存档 → 看 `local/gamedata/saves/slotN.json` 真出现 → 换个 origin(localhost / 换端口)打开,
同一批档还在。单测见 `src/core/SaveManager.test.ts` 的迁移与降级两组。
