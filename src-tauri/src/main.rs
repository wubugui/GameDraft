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

/// WebView2（= Chromium）的启动参数，只在 Windows 上有这回事。
///
/// 缺省的 WebView2 带着浏览器那套行为：没点过页面 AudioContext 不出声；窗口没焦点 / 被别的窗口盖住就把页面
/// 降成"后台"（定时器节流、rAF 停）。**这是桌面客户端，一律关掉**（制作人 2026-09-08）。
/// 第一项是 wry 的缺省参数——一旦自定义 `additional_browser_args` 就得自己带上（tauri 文档如是说）。
#[cfg(windows)]
const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --autoplay-policy=no-user-gesture-required \
    --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

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

/// `game_config.json` 读不到 / 没配时的窗口尺寸。与游戏的标准视口一致（4:3）。
const FALLBACK_WINDOW_SIZE: (f64, f64) = (1024.0, 768.0);

/// 从 `game_config.json` 的文本里取窗口尺寸：`windowSize`，没有则 `viewport`。
///
/// 只认合理范围内的正数（320×240 … 8192×8192），别的一律当没配——一个手滑写成 0 或负数的
/// 配置不该让窗口开成一条线。
fn window_size_from_config(text: &str) -> Option<(f64, f64)> {
    let root: serde_json::Value = serde_json::from_str(text).ok()?;
    for key in ["windowSize", "viewport"] {
        let Some(node) = root.get(key) else { continue };
        let w = node.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let h = node.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if (320.0..=8192.0).contains(&w) && (240.0..=8192.0).contains(&h) {
            return Some((w, h));
        }
    }
    None
}

/// 窗口初始尺寸**跟 game_config.json 的 `windowSize` 走**，不写死在这里。
///
/// 编辑器 F5 的预览窗按同一个字段开（`tools/editor/main_window.py`），两边才是同一份真相。
/// 2026-09-06 之前这里写死 1280×720（16:9），而游戏的逻辑视口是 1024×768（4:3）——
/// 编辑器里比例对、exe 里横向拉宽 25%，"打包出来比例不对"就是这么来的。
///
/// 读的是 exe 旁 `game/assets/data/game_config.json`（`web_root` 已经知道内容根在哪），
/// 读不到就回落并 `eprintln!`（dev 构建有控制台能看见）；绝不 panic——窗口尺寸不该挡住开局。
fn preferred_window_size(app: &tauri::AppHandle) -> (f64, f64) {
    let cfg = web_root::resolve_web_root(app)
        .join("assets")
        .join("data")
        .join("game_config.json");
    match std::fs::read_to_string(&cfg) {
        Ok(text) => window_size_from_config(&text).unwrap_or_else(|| {
            eprintln!(
                "[window] {} 里没有可用的 windowSize/viewport，窗口按 {}×{} 开",
                cfg.display(),
                FALLBACK_WINDOW_SIZE.0,
                FALLBACK_WINDOW_SIZE.1
            );
            FALLBACK_WINDOW_SIZE
        }),
        Err(e) => {
            eprintln!(
                "[window] 读不到 {}（{e}），窗口按 {}×{} 开",
                cfg.display(),
                FALLBACK_WINDOW_SIZE.0,
                FALLBACK_WINDOW_SIZE.1
            );
            FALLBACK_WINDOW_SIZE
        }
    }
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
            // 逻辑像素（Windows 缩放 125%/150% 下 WebView 的 CSS px 也是逻辑像素，比例不受影响）。
            // 前端按视口比例做等比信箱（src/rendering/Renderer.ts layoutMount），所以窗口被拖成
            // 任何形状都不失真；这里只负责"首开就是标准比例、能放进屏幕"。
            let (w, h) = preferred_window_size(app.handle());
            let builder = WebviewWindowBuilder::new(app, "main", window_url())
                .title("GameDraft")
                .inner_size(w, h)
                // 与主尺寸同比例；再小画面就看不清了
                .min_inner_size(w / 2.0, h / 2.0)
                .resizable(true)
                .center()
                // 150% 缩放的 1080p 屏逻辑高只有 720，放不下 768：缩进工作区而不是溢出屏幕
                .prevent_overflow();
            // 桌面客户端不许有浏览器的"没点过不出声、没焦点就降级"（见 WEBVIEW2_ARGS）
            #[cfg(windows)]
            let builder = builder.additional_browser_args(WEBVIEW2_ARGS);
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("GameDraft 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_size_prefers_window_size_then_viewport() {
        let both = r#"{"viewport":{"width":1024,"height":768},"windowSize":{"width":1280,"height":960}}"#;
        assert_eq!(window_size_from_config(both), Some((1280.0, 960.0)));
        let only_viewport = r#"{"viewport":{"width":1024,"height":768}}"#;
        assert_eq!(window_size_from_config(only_viewport), Some((1024.0, 768.0)));
    }

    #[test]
    fn window_size_rejects_garbage_and_falls_through() {
        assert_eq!(window_size_from_config("{not json"), None);
        assert_eq!(window_size_from_config(r#"{"initialScene":"x"}"#), None);
        // 0 / 负数 / 超范围 / 字符串：当没配，落到下一个键或 None
        assert_eq!(window_size_from_config(r#"{"windowSize":{"width":0,"height":768}}"#), None);
        assert_eq!(window_size_from_config(r#"{"windowSize":{"width":-1024,"height":768}}"#), None);
        assert_eq!(window_size_from_config(r#"{"windowSize":{"width":"1024","height":"768"}}"#), None);
        assert_eq!(
            window_size_from_config(r#"{"windowSize":{"width":99999,"height":768},"viewport":{"width":1024,"height":768}}"#),
            Some((1024.0, 768.0))
        );
    }

    #[test]
    fn real_game_config_in_repo_is_4_by_3() {
        // 仓库里那份就是运行时读的那份（打包原样抽取）：钉住它是 4:3，改了要有人知道
        let text = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../public/assets/data/game_config.json"),
        )
        .expect("public/assets/data/game_config.json 应当存在");
        let (w, h) = window_size_from_config(&text).expect("game_config 应配了 windowSize/viewport");
        assert!((w / h - 4.0 / 3.0).abs() < 0.01, "标准视口比例应为 4:3，现在是 {w}×{h}");
    }
}
