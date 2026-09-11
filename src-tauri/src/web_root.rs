//! 把游戏内容从 **exe 旁的文件夹**喂给 webview，而不是塞进 exe 里。
//!
//! # 为什么不用 Tauri 默认的 frontendDist
//!
//! 默认做法是把前端整棵树编译进二进制。这个项目的内容有 700 MB 以上（背景、立绘、
//! 光照烘焙载荷），塞进 exe 会得到一个 700 MB 的单文件：编译慢、内存吃紧、改一张图
//! 要重新链接整个二进制，而且玩家看不见也换不了里面的东西。
//!
//! 所以走自定义协议：exe 小（只有引擎和 JS/CSS），内容作为**普通文件**躺在
//! `<exe 目录>/game/` 下。这也正是"东西就该从本地文件夹读"的那个直觉。
//!
//! # URL 怎么对上
//!
//! 游戏里所有资源路径都是站点根绝对路径（`/assets/data/x.json`、
//! `/resources/runtime/images/y.png`，见 `src/core/projectPaths.ts`）。
//! 窗口开在 `gamedraft://localhost/`，于是这些路径原样落到本模块，
//! 再解析成 `<game 根>/assets/data/x.json`。**前端一行都不用改**。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use tauri::Manager;

static WEB_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 内容根：`<exe 目录>/game/`；开发/异常情况下退到 Tauri 的资源目录。
pub fn resolve_web_root(app: &tauri::AppHandle) -> PathBuf {
    WEB_ROOT
        .get_or_init(|| {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let beside = dir.join("game");
                    if beside.join("index.html").is_file() {
                        return beside;
                    }
                }
            }
            let res = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("game");
            if !res.join("index.html").is_file() {
                eprintln!(
                    "[web_root] 找不到 index.html：既不在 exe 旁的 game/，也不在 {}",
                    res.display()
                );
            }
            res
        })
        .clone()
}

/// 把请求路径安全地解析到内容根下。
///
/// 逐段拒绝 `..` 与绝对路径根：**不能**靠"解析完再检查前缀"，符号链接会让那种检查失效。
/// 解析不出来返回 `None`，由调用方回 404。
fn safe_join(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path);
    let trimmed = decoded.trim_start_matches('/');
    let rel = if trimmed.is_empty() { "index.html" } else { trimmed };

    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            // `..` / 盘符 / 根：一律拒绝，不做任何"聪明"的规整
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(out)
}

/// 最小 percent-decode（URL 里的中文场景名会被编码，例如 `%E9%9B%BE%E6%B4%A5`）。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 按扩展名给 Content-Type。认不出来的一律 `application/octet-stream`
/// —— 猜错类型比不猜更糟（浏览器会按错的方式解码）。
fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        // CSP 里放了 'wasm-unsafe-eval'；真引入 wasm 时 instantiateStreaming 会按
        // Content-Type 拒收 application/octet-stream，缺这一行就是一句难查的报错
        Some("wasm") => "application/wasm",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("glsl") | Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 自定义协议处理：一次请求 → 一个文件。
///
/// 404 也返回一个**带说明的正文**，而不是空响应——发行版里漏抽一个素材时，
/// 控制台能直接看出是"哪个路径没找到"，不用去猜。
pub fn handle_request(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let root = resolve_web_root(app);
    let path = request.uri().path().to_string();

    let Some(disk) = safe_join(&root, &path) else {
        return not_found(&format!("非法路径：{path}"));
    };
    if !disk.is_file() {
        return not_found(&format!("找不到：{path}"));
    }
    match fs::read(&disk) {
        Ok(bytes) => ok_response(bytes, content_type_for(&disk)),
        Err(e) => not_found(&format!("读取失败 {}: {e}", disk.display())),
    }
}

/// 一个字节都不许进 webview 的缓存(制作人 2026-09-08 定死:桌面窗口一律禁缓存)。
///
/// 这里原来发的是 `public, max-age=31536000, immutable`，理由写的是"内容随 exe 一起发、
/// 版本固定"。两处站不住：
///
/// 1. 内容在 **exe 旁边的 `game/` 文件夹**里(见模块头),换一张图不换文件名正是这套设计的
///    卖点——`immutable` 等于允许 WebView2 在一年内理直气壮地喂旧字节;
/// 2. 缓存在这里买不到任何东西:文件本来就躺在本机磁盘上,走一层缓存只是把同一份数据抄进
///    WebView2 的缓存目录再读回来,却换来一整类**"缓存烂了 → 玩家一屏黑、且毫无线索"**
///    的故障(2026-09-08 编辑器预览窗被 Chromium 那份磁盘缓存坑掉一整天,就是这一类)。
fn ok_response(bytes: Vec<u8>, content_type: &'static str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| not_found("构造响应失败"))
}

fn not_found(msg: &str) -> tauri::http::Response<Vec<u8>> {
    let body = format!("404 {msg}").into_bytes();
    match tauri::http::Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(body)
    {
        Ok(r) => r,
        // `Response::default()` 的状态码是 **200**——用 unwrap_or_default 兜底，
        // 会把"找不到"变成"找到了，内容是空的"，前端只会看到一个空文件而不是错误。
        // builder 在这里几乎不可能失败，但兜底也得兜到 404 上。
        Err(_) => {
            let mut r = tauri::http::Response::new(Vec::new());
            *r.status_mut() = tauri::http::StatusCode::NOT_FOUND;
            r
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{content_type_for, ok_response, percent_decode, safe_join};
    use std::path::Path;

    #[test]
    fn 游戏内容一律不进缓存() {
        // 桌面窗口禁缓存是规矩,不是优化选项:这条头一旦变回 max-age/immutable,
        // 玩家机器上就会再长出一份能烂掉、且烂了没有任何线索的游戏副本。
        let res = ok_response(b"x".to_vec(), "text/plain");
        assert_eq!(res.headers().get("Cache-Control").unwrap(), "no-store");
    }

    #[test]
    fn 空路径落到_index_html() {
        let root = Path::new("C:/game");
        assert_eq!(
            safe_join(root, "/").unwrap(),
            Path::new("C:/game").join("index.html")
        );
    }

    #[test]
    fn 拒绝路径穿越() {
        let root = Path::new("C:/game");
        assert!(safe_join(root, "/../secret.txt").is_none());
        assert!(safe_join(root, "/assets/../../secret.txt").is_none());
        assert!(safe_join(root, "/%2e%2e/secret.txt").is_none());
    }

    #[test]
    fn 中文路径解码() {
        assert_eq!(percent_decode("/%E9%9B%BE%E6%B4%A5.json"), "/雾津.json");
    }

    #[test]
    fn 认不出的扩展名走八位字节流() {
        assert_eq!(content_type_for(Path::new("a.bin")), "application/octet-stream");
        assert_eq!(content_type_for(Path::new("a.png")), "image/png");
        assert_eq!(content_type_for(Path::new("a.wasm")), "application/wasm");
    }

    /// 窗口开在 `index.html?screen_title=1`（见 main.rs 的 window_url）。
    /// 查询串由前端读，**不该进到文件查找里**——`Uri::path()` 本来就不含它，
    /// 这条钉死这个前提，免得哪天有人改成 `to_string()` 或手工拼路径。
    #[test]
    fn 查询串不参与文件查找() {
        let uri: tauri::http::Uri = "http://gamedraft.localhost/index.html?screen_title=1"
            .parse()
            .unwrap();
        assert_eq!(uri.path(), "/index.html");
        let root = Path::new("C:/game");
        assert_eq!(
            safe_join(root, uri.path()).unwrap(),
            Path::new("C:/game").join("index.html"),
        );
    }
}
