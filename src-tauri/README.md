# 桌面壳（Tauri v2）

`tauri.conf.json` 的 schema 是**严格模式**：多一个属性都会让构建直接失败，
所以那份配置里一行注释都放不下。每个非默认选项为什么这么写，记在这里。

完整的打包管线见 [`agent_docs/runtime/mechanisms/build-pipeline.md`](../agent_docs/runtime/mechanisms/build-pipeline.md)。

## 这一层只干两件事

1. **把游戏内容喂给 webview** —— 自定义协议 `gamedraft`，从 exe 旁的 `game/` 读普通文件
   （`src/web_root.rs`）。内容**不塞进 exe**。
2. **提供存档/设置的文件读写** —— `gamedata_*` 命令（`src/gamedata.rs`），
   落在 exe 旁的 `gamedata/`。

游戏逻辑一行都不在这里。前端跑的是跟开发期完全同一份代码，唯一差别是持久化后端
从 dev server 换成了这里的命令。

## 配置逐条为什么

### `app.withGlobalTauri: true` —— 关掉的话发行版存档必坏

v2 **默认 false 且不注入 `window.__TAURI__`**（v1 该字段在 `build` 下，别照 v1 抄）。
前端靠这个全局判断自己在不在 exe 里（`src/core/storage/persistentStore.ts` 的
`tauriInvoke`），项目又没装 `@tauri-apps/api`、不 import 任何 Tauri 模块。

关着的话失败链是完整且静默的：探测挑不到 Tauri → 退 HTTP → 打不通 → **降级内存**，
玩家存了档关掉就没。而且**验收门看不出来**——它把 `/__gamedraft-api/` 的 404 列为预期
（那是给静态托管场景的豁免），坏掉的 exe 长得跟正常一模一样。

### `app.windows: []` —— 窗口在 Rust 里建

同一个自定义协议在两类平台上形态不同：

| 平台 | 形态 |
|---|---|
| Windows / Android | `http://<scheme>.localhost/<path>` |
| macOS / iOS / Linux | `<scheme>://localhost/<path>` |

JSON 只能写死一种，写错那种在目标平台上 webview 根本不认识这个 scheme，导航失败给你
一张白页。改由 `src/main.rs` 的 `window_url()` 用 `cfg!` 按平台拼，窗口在 `setup()` 里建。

### 窗口尺寸跟 `game_config.json` 走，不写死

`setup()` 里建窗前先读 exe 旁 `game/assets/data/game_config.json` 的 `windowSize`
（没有则 `viewport`；读不到回落 1024×768），`inner_size` 按它开、`min_inner_size` 取一半同比例，
并 `prevent_overflow()`（150% 缩放的 1080p 屏逻辑高只有 720，放不下 768 就缩进工作区）。

编辑器 F5 的预览窗按**同一个字段**开——这样两边是同一份真相。2026-09-06 之前这里写死
1280×720（16:9），而游戏的逻辑视口是 1024×768（4:3）：编辑器里比例对、exe 里横向拉宽 25%。
比例本身由前端保证（`src/rendering/Renderer.ts` 的 `layoutMount` 按视口比例做等比信箱），
壳只负责"首开就是标准比例、放得进屏幕"；用户拖窗/最大化后画面等比放大、余下黑边。

### `build.frontendDist: "shell"` —— 一个占位空壳

真正的前端由 `scripts/package.mjs` 抽取到 `release/release/game/`，运行时经自定义协议
从 exe 旁读。这里只需要一个能过构建期存在性检查的目录。

### 窗口 URL 不带启动参数

「发行版停在标题界面 / dev 版从某个场景起」**不由壳决定**。写死在这里的话：
只有 exe 形态生效（同一份 `game/` 用静态服务器托起来就没有），而且档位一变
就得改 Rust 重新编译。

改由打包器按档位烘进产物（`scripts/package.mjs` 写 `boot.js`，配置在
`tools/build/build_config.json`，运行时逻辑在 `src/core/bootParams.ts`）。
壳只管开首页，两种形态走同一套规则。

### `bundle.resources` —— 内容作为外部资源

`{"../release/release/game": "game"}`：把打好的游戏内容装到 exe 旁的 `game/`。
路径相对本目录解析。**打包前必须先跑 `npm run package:release`**，否则这个目录不存在。

### `bundle.windows.nsis.installMode: "currentUser"`

不能用 `perMachine`。存档的落点是「exe 旁 `gamedata/` 优先，不可写才退 AppData」；
装进 Program Files 之后，普通启动落 AppData、某次「以管理员身份运行」落 Program Files，
**同一台机器两份互不相通的存档按启动方式左右横跳**——正好是这整轮改动要消灭的那个
bug 的形态。装到用户目录下，exe 旁恒可写，便携语义才稳定。

## 图标

`icons/` 下的是占位（民俗纸灯笼剪影，配色对齐 UI 的纸黄/夜底）。
生成脚本 `make_icons.py` 留着是为了让"图标怎么来的"有据可查，不是几个来历不明的二进制。
正式图标出来直接换文件即可，脚本不用再跑。

```bash
python src-tauri/make_icons.py
```

## 构建与测试

```bash
npm run package:release   # 先备好 release/release/game/
npm run tauri:build       # 上面这步 + tauri build，出 NSIS 安装包
npm run test:tauri        # Rust 单测（13 条：路径穿越、原子写入、UTF-8 往返等）
```

需要 Rust 工具链（`winget install Rustlang.Rustup`）与 MSVC C++ 生成工具。

**打包时不要开着 `gamedraft.exe`。** NSIS 收尾要动那个文件，被占用会以
`failed to bundle project: (os error 32)` 结束——安装包其实已经生成了，
但报错看着像整个失败，会让人以为构建坏了。

测试名是中文；Windows 控制台默认 GBK 会显示成乱码（结果本身不受影响）。
要看清跑 `chcp 65001` 之后再跑，或者用支持 UTF-8 的终端。

## 怎么验"它真的在用 Tauri 后端"

不用看画面。前端启动时会调 `gamedata_read_all` 探测后端，那会触发 Rust 侧
`create_dir_all(<exe 目录>/gamedata)`。所以：

> **exe 旁出现 `gamedata/` 目录 = 内容加载成功 + `window.__TAURI__` 注入成功 +
> 选中的是 Tauri 后端而不是内存降级。**

一个目录同时证明三件事，回归时照用。反过来，如果它没出现，八成是
`withGlobalTauri` 又被关掉了。
