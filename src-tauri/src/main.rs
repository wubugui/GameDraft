// Windows 发行构建不要后面那个黑色控制台窗口（dev 构建保留，好看日志）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! GameDraft 桌面壳。
//!
//! 这一层只干两件事，别的都不管：
//!
//! 1. **把游戏内容喂给 webview** —— 自定义协议 `gamedraft`，从 exe 旁的 `game/`
//!    文件夹读文件（见 [`web_root`]）。内容不塞进 exe。
//! 2. **提供存档/设置的文件读写** —— `gamedata_*` 命令（见 [`gamedata`]），
//!    落在 exe 旁的 `gamedata/`。
//!
//! 游戏逻辑一行都不在这里。前端跑在浏览器引擎里，跟开发期完全同一份代码——
//! 唯一的差别是持久化后端从 dev server 换成了这里的命令（前端侧的挑选逻辑见
//! `src/core/storage/persistentStore.ts` 的 `resolvePersistentStore`）。

mod gamedata;
mod web_root;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 自定义协议名。改这里要同时改 `tauri.conf.json` 的 CSP。
const SCHEME: &str = "gamedraft";

/// 窗口该开在哪个 URL。
///
/// # 平台形态
///
/// **同一个协议在两类平台上长得不一样**（`register_uri_scheme_protocol` 的文档明确列了）：
///
/// | 平台 | 形态 |
/// |---|---|
/// | Windows / Android | `http://<scheme>.localhost/<path>` |
/// | macOS / iOS / Linux | `<scheme>://localhost/<path>` |
///
/// 所以这个 URL **不能写在 tauri.conf.json 里**——JSON 只能写死一种，写 macOS 那种
/// 在 Windows 上 WebView2 根本不认识这个 scheme，导航直接失败给你一张白页。
/// 放在这里用 `cfg!` 拼，编译期就按平台定死，写不错。
///
/// # 这里**不带**启动参数
///
/// 「发行版停在标题界面 / dev 版从某个场景起」这件事**不由壳决定**——那样只有 exe
/// 形态生效，网页形态的产物（同一份 `game/` 用静态服务器托起来）就没有；而且档位一变
/// 就得改 Rust 重新编译。
///
/// 改由打包器按档位把启动缺省烘进产物（`scripts/package.mjs` 写 `boot.js`，
/// 配置在 `tools/build/build_config.json`，运行时逻辑在 `src/core/bootParams.ts`）。
/// 壳只管开首页，两种形态走同一套规则。
fn window_url() -> WebviewUrl {
    let raw = if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/index.html")
    } else {
        format!("{SCHEME}://localhost/index.html")
    };
    // 两种形态都是合法绝对 URL；解析不出来是编译期就能发现的拼写错误，直接 panic 比
    // 悄悄回落到别的页面强。
    WebviewUrl::External(raw.parse().expect("窗口 URL 拼错了"))
}

fn main() {
    tauri::Builder::default()
        .register_uri_scheme_protocol(SCHEME, |ctx, request| {
            web_root::handle_request(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
            gamedata::gamedata_read_all,
            gamedata::gamedata_write,
            gamedata::gamedata_remove,
            gamedata::gamedata_root,
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", window_url())
                .title("GameDraft")
                .inner_size(1280.0, 720.0)
                .min_inner_size(960.0, 540.0)
                .resizable(true)
                .center()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("GameDraft 启动失败");
}
