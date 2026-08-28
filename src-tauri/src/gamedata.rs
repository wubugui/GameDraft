//! 存档 / 玩家设置的文件后端（打包侧）。
//!
//! 与开发期 dev server 中间件（`vite.config.ts` 的 `persistentStoreApi`）**同一套语义**：
//! `<根>/<namespace>/<key>.json`，一个键一个文件。两边的 JSON 格式一模一样，
//! 开发期存的档拷进发行版的存档目录就能接着玩，反之亦然。
//!
//! # 落在哪
//!
//! `<exe 所在目录>/gamedata/`。**便携优先**：整个游戏文件夹拷到 U 盘、拷到另一台机器，
//! 存档跟着走；玩家想备份存档就是复制一个文件夹，不用去翻 AppData。
//!
//! exe 目录不可写时（装在 Program Files 之类）退到系统的应用数据目录，
//! 并在日志里说明——绝不静默把存档写到一个玩家找不到的地方。
//!
//! # 安全
//!
//! `namespace` 与 `key` 都只允许 `[A-Za-z0-9_-]`，在拼进路径**之前**校验。
//! 前端理论上已经拦过一道，但这一层是最后一道：拼路径的地方不校验，就等于把
//! 路径穿越交给调用方。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::Manager;

/// 允许的命名空间/键名字符集。故意收得很紧——它们会变成目录名与文件名。
fn is_valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 解析存档根目录，只算一次。
///
/// 1. `<exe 目录>/gamedata/` —— 便携首选，能建出来就用它；
/// 2. 建不出来（只读安装目录）→ 应用数据目录 `<app_data>/gamedata/`。
fn resolve_root(app: &tauri::AppHandle) -> PathBuf {
    ROOT.get_or_init(|| {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let portable = dir.join("gamedata");
                if fs::create_dir_all(&portable).is_ok() && is_writable(&portable) {
                    return portable;
                }
            }
        }
        let fallback = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("gamedata");
        let _ = fs::create_dir_all(&fallback);
        eprintln!(
            "[gamedata] exe 目录不可写，存档改落在 {}",
            fallback.display()
        );
        fallback
    })
    .clone()
}

/// 真去写一个探测文件——`create_dir_all` 成功不代表目录可写
/// （Windows 上 Program Files 会给你一个"成功"再把写入重定向到 VirtualStore）。
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".write_probe");
    match fs::File::create(&probe) {
        Ok(mut f) => {
            let ok = f.write_all(b"1").is_ok();
            drop(f);
            let _ = fs::remove_file(&probe);
            ok
        }
        Err(_) => false,
    }
}

fn ns_dir(app: &tauri::AppHandle, namespace: &str) -> Result<PathBuf, String> {
    if !is_valid_name(namespace) {
        return Err(format!("非法 namespace: {namespace}"));
    }
    Ok(resolve_root(app).join(namespace))
}

fn key_path(app: &tauri::AppHandle, namespace: &str, key: &str) -> Result<PathBuf, String> {
    if !is_valid_name(key) {
        return Err(format!("非法 key: {key}"));
    }
    Ok(ns_dir(app, namespace)?.join(format!("{key}.json")))
}

/// 读出一个命名空间下的全部键值，供前端启动时一次性水化。
///
/// 目录不存在 = 空，不是错误（第一次玩本来就没有存档）。单个文件读不了只跳过它，
/// 不让一个坏文件把整次水化拖垮——那会让玩家的另外两个好档一起"消失"。
#[tauri::command]
pub fn gamedata_read_all(
    app: tauri::AppHandle,
    namespace: String,
) -> Result<HashMap<String, String>, String> {
    read_all_in(&ns_dir(&app, &namespace)?)
}

/// [`gamedata_read_all`] 的纯逻辑：只认一个目录，不碰 `AppHandle`。
///
/// 拆出来是为了**能测**。命令本体要 `AppHandle`，那东西在单测里造不出来，
/// 于是整段读写逻辑会一行都覆盖不到——而这段代码的错法（丢档、留 `.tmp`、
/// 把坏文件当成全部失败）恰恰是最不该靠"看着对"来保证的。
fn read_all_in(dir: &Path) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_name(stem) {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(text) => {
                out.insert(stem.to_string(), text);
            }
            Err(e) => eprintln!("[gamedata] 读不了 {}: {e}", path.display()),
        }
    }
    Ok(out)
}

/// 写一个键。
///
/// **先写临时文件再原子改名**：直接覆写时，如果在写到一半掉电/被杀，
/// 玩家拿到的是一个被截断的存档——比没存上还糟，因为它看起来存在。
///
/// 不要在 rename 之前先 `remove_file` 目标。Rust 的 `fs::rename` 在 Windows 上走
/// `MoveFileEx` + `MOVEFILE_REPLACE_EXISTING`，本来就覆盖已存在的文件；先删一次
/// 只会**亲手造出上面这段话想消灭的那个窗口**——删完还没改完名时掉电，旧档没了、
/// 新档还叫 `.json.tmp`（而 `gamedata_read_all` 只认 `.json`），槽位直接空掉。
#[tauri::command]
pub fn gamedata_write(
    app: tauri::AppHandle,
    namespace: String,
    key: String,
    value: String,
) -> Result<(), String> {
    write_at(&key_path(&app, &namespace, &key)?, &value)
}

/// [`gamedata_write`] 的纯逻辑：只认一个目标路径。理由同 [`read_all_in`]。
fn write_at(path: &Path, value: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("路径没有父目录")?;
    fs::create_dir_all(dir).map_err(|e| format!("建目录失败 {}: {e}", dir.display()))?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("建临时文件失败 {}: {e}", tmp.display()))?;
        f.write_all(value.as_bytes())
            .map_err(|e| format!("写入失败: {e}"))?;
        if !value.ends_with('\n') {
            f.write_all(b"\n").map_err(|e| format!("写入失败: {e}"))?;
        }
        f.sync_all().map_err(|e| format!("落盘失败: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        // 改名失败就把临时文件收掉，别在存档目录里攒一堆没人管的 .json.tmp
        let _ = fs::remove_file(&tmp);
        format!("改名失败: {e}")
    })?;
    Ok(())
}

/// 删一个键。本来就不存在按成功处理。
#[tauri::command]
pub fn gamedata_remove(
    app: tauri::AppHandle,
    namespace: String,
    key: String,
) -> Result<(), String> {
    remove_at(&key_path(&app, &namespace, &key)?)
}

/// [`gamedata_remove`] 的纯逻辑。理由同 [`read_all_in`]。
fn remove_at(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除失败 {}: {e}", path.display())),
    }
}

/// 存档目录的绝对路径，给"打开存档文件夹"这类入口和排障用。
#[tauri::command]
pub fn gamedata_root(app: tauri::AppHandle) -> String {
    resolve_root(&app).display().to_string()
}

#[cfg(test)]
mod tests {
    use super::{is_valid_name, read_all_in, remove_at, write_at};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn 名字校验挡住路径穿越() {
        assert!(is_valid_name("slot0"));
        assert!(is_valid_name("gamedraft_saves_migrated"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name(".."));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name("a\\b"));
        assert!(!is_valid_name("a.json"));
        assert!(!is_valid_name(&"x".repeat(65)));
    }

    /// 每个用例一个独立临时目录；用例名当后缀，避免并行跑时互相踩。
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gamedraft_test_{tag}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 写进去读得回来() {
        let d = tmp_dir("roundtrip");
        write_at(&d.join("slot0.json"), r#"{"a":1}"#).unwrap();
        let all = read_all_in(&d).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all["slot0"].trim(), r#"{"a":1}"#);
    }

    #[test]
    fn 没有换行的内容会被补上换行() {
        let d = tmp_dir("newline");
        write_at(&d.join("k.json"), "{}").unwrap();
        assert_eq!(fs::read_to_string(d.join("k.json")).unwrap(), "{}\n");
        // 已经有换行的不再叠一个
        write_at(&d.join("k2.json"), "{}\n").unwrap();
        assert_eq!(fs::read_to_string(d.join("k2.json")).unwrap(), "{}\n");
    }

    #[test]
    fn 覆写不留临时文件_也不需要先删目标() {
        let d = tmp_dir("overwrite");
        let p = d.join("slot0.json");
        write_at(&p, r#"{"v":1}"#).unwrap();
        // 关键：目标已存在时直接 rename 覆盖（Windows 上 MoveFileEx 就是这个语义），
        // 不许先 remove_file —— 那会造出"旧档已删、新档还叫 .json.tmp"的丢档窗口
        write_at(&p, r#"{"v":2}"#).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap().trim(), r#"{"v":2}"#);

        let leftovers: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "留下了临时文件: {leftovers:?}");
    }

    #[test]
    fn 目录不存在时会自己建() {
        let d = tmp_dir("mkdir").join("saves");
        write_at(&d.join("slot0.json"), "{}").unwrap();
        assert!(d.join("slot0.json").is_file());
    }

    #[test]
    fn 读取只认_json_跳过其它文件() {
        let d = tmp_dir("filter");
        write_at(&d.join("slot0.json"), "{}").unwrap();
        fs::write(d.join("notes.txt"), "x").unwrap();
        fs::write(d.join("slot1.json.tmp"), "x").unwrap();
        let all = read_all_in(&d).unwrap();
        assert_eq!(all.keys().collect::<Vec<_>>(), vec!["slot0"]);
    }

    #[test]
    fn 目录不存在等于空_不是错误() {
        let d = std::env::temp_dir().join("gamedraft_test_absent_dir");
        let _ = fs::remove_dir_all(&d);
        assert!(read_all_in(&d).unwrap().is_empty());
    }

    #[test]
    fn 删掉之后读不到_删不存在的算成功() {
        let d = tmp_dir("remove");
        let p = d.join("slot0.json");
        write_at(&p, "{}").unwrap();
        remove_at(&p).unwrap();
        assert!(read_all_in(&d).unwrap().is_empty());
        // 本来就没有 = 成功，不该报错
        remove_at(&p).unwrap();
    }

    #[test]
    fn 中文内容按_utf8_原样往返() {
        let d = tmp_dir("utf8");
        let payload = r#"{"scene":"雾津街头","npc":"癞子"}"#;
        write_at(&d.join("slot0.json"), payload).unwrap();
        assert_eq!(read_all_in(&d).unwrap()["slot0"].trim(), payload);
    }
}
