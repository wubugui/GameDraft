# -*- coding: utf-8 -*-
"""音频编辑器后端 —— 波形裁剪 / 淡入淡出 / 增益 / 一键导出进项目。

设计要点:
  * 非破坏式:编辑参数存 edits.json,原始文件永不改写;导出时才用 ffmpeg 渲染。
  * 多来源:生成批次 out/、用户导入 imported/、项目现有 audio/ 都能编辑。
  * 导出落位:音频进 public/resources/runtime/audio/<批次目录>/,
    并按类别登记进 audio_config.json 的 bgm / ambient / sfx 三个区。
  * audio_config.json 用文本级插入改写(不做 json.load->dumps 回写),
    否则整个文件会被重新格式化,PyQt 编辑器的往返契约会碎。

启动: python3 tools/audio_editor/server.py   (默认 http://127.0.0.1:8790)
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
STATIC = HERE / "static"
IMPORTED = HERE / "imported"
CACHE = HERE / ".cache"
EDITS = HERE / "edits.json"

PROJECT_AUDIO = REPO / "public/resources/runtime/audio"
AUDIO_CONFIG = REPO / "public/assets/data/audio_config.json"
BATCH_OUT = REPO / "tmp/audio_batch_20260809/out"

# 导出批次目录(音频落这里)
EXPORT_SUBDIR = "edited"
# audio_config 的三个区 <- 编辑器里的类别
CATEGORY_SECTIONS = {"bgm": "bgm", "ambient": "ambient", "sfx": "sfx"}

PORT = int(os.environ.get("AUDIO_EDITOR_PORT", "8790"))

SOURCES: dict[str, Path] = {
    "batch": BATCH_OUT,
    "imported": IMPORTED,
    "project": PROJECT_AUDIO,
}

AUDIO_EXT = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aif", ".aiff"}


# ---------------------------------------------------------------- 工具

def ffprobe_duration(p: Path) -> float | None:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(p)],
        capture_output=True, text=True,
    )
    try:
        return round(float(r.stdout.strip()), 3)
    except ValueError:
        return None


def load_edits() -> dict:
    if EDITS.exists():
        try:
            return json.loads(EDITS.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_edits(d: dict) -> None:
    EDITS.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def safe_under(root: Path, rel: str) -> Path | None:
    """挡住 ../ 越权访问。"""
    p = (root / rel).resolve()
    try:
        p.relative_to(root.resolve())
    except ValueError:
        return None
    return p


def guess_category(key: str) -> str:
    name = key.rsplit("/", 1)[-1].lower()
    if "/bgm/" in key or name.startswith("bgm"):
        return "bgm"
    if any(t in key for t in ("/bgs/", "amb_")) or name.startswith(("amb", "bgs")):
        return "ambient"
    return "sfx"


def default_export_id(key: str) -> str:
    stem = Path(key).stem
    # 去掉批次生成的 _a/_b 版本后缀,导出 id 用干净名字
    return re.sub(r"_(a|b)$", "", stem)


# ---------------------------------------------------------------- 渲染

def build_filter(ed: dict, dur: float) -> tuple[list[str], float]:
    """按编辑参数拼 ffmpeg 滤镜链,返回 (滤镜列表, 输出时长)。"""
    trim = ed.get("trim") or {}
    start = max(0.0, float(trim.get("start") or 0))
    end = float(trim.get("end") or dur)
    end = min(end, dur)
    if end <= start:
        start, end = 0.0, dur
    out_dur = end - start

    filters = [f"atrim=start={start:.4f}:end={end:.4f}", "asetpts=PTS-STARTPTS"]

    fi = float(ed.get("fadeIn") or 0)
    fo = float(ed.get("fadeOut") or 0)
    if fi > 0:
        filters.append(f"afade=t=in:st=0:d={min(fi, out_dur):.4f}")
    if fo > 0:
        fo = min(fo, out_dur)
        filters.append(f"afade=t=out:st={max(0.0, out_dur - fo):.4f}:d={fo:.4f}")

    if ed.get("reverse"):
        filters.append("areverse")

    gain = float(ed.get("gainDb") or 0)
    if gain:
        filters.append(f"volume={gain:.2f}dB")

    norm = ed.get("normalize") or {}
    if norm.get("enabled"):
        # 峰值归一:先测再抬(两遍),这里只放占位,实际在 render 里两遍处理
        pass

    return filters, out_dur


def measure_peak(p: Path, filters: list[str]) -> float | None:
    af = ",".join(filters + ["volumedetect"]) if filters else "volumedetect"
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(p), "-af", af, "-f", "null", "-"],
        capture_output=True, text=True,
    )
    for line in r.stderr.splitlines():
        if "max_volume:" in line:
            try:
                return float(line.split("max_volume:")[1].strip().split()[0])
            except (ValueError, IndexError):
                return None
    return None


def render(src: Path, ed: dict, dst: Path) -> tuple[bool, str]:
    dur = ffprobe_duration(src) or 0
    filters, _ = build_filter(ed, dur)

    norm = ed.get("normalize") or {}
    if norm.get("enabled"):
        target = float(norm.get("peakDb", -3))
        peak = measure_peak(src, filters)
        if peak is not None:
            filters.append(f"volume={target - peak:.2f}dB")

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(src)]
    if filters:
        cmd += ["-af", ",".join(filters)]
    if dst.suffix.lower() == ".mp3":
        cmd += ["-b:a", "192k"]
    cmd.append(str(dst))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        return False, r.stderr[-400:]
    return True, ""


# ---------------------------------------------------------------- audio_config 写入

def audio_config_plan(entries: list[dict]) -> list[dict]:
    """返回将对 audio_config.json 做的改动(不落盘)。"""
    text = AUDIO_CONFIG.read_text(encoding="utf-8")
    plan = []
    for e in entries:
        section = CATEGORY_SECTIONS[e["category"]]
        aid = e["audio_id"]
        exists = re.search(
            rf'"{re.escape(aid)}"\s*:\s*\{{', text
        ) is not None
        plan.append({"audio_id": aid, "section": section,
                     "src": e["src"], "action": "update" if exists else "add"})
    return plan


def audio_config_apply(entries: list[dict]) -> dict:
    """文本级插入/更新,保住原文件的缩进与键序(禁 json.load->dumps 回写)。"""
    text = AUDIO_CONFIG.read_text(encoding="utf-8")
    backup = AUDIO_CONFIG.with_suffix(
        f".bak-{time.strftime('%Y%m%d-%H%M%S')}.json")
    backup.write_text(text, encoding="utf-8")

    added, updated = [], []
    for e in entries:
        section = CATEGORY_SECTIONS[e["category"]]
        aid, src = e["audio_id"], e["src"]

        # 已存在 -> 只换 src 那一行
        m = re.search(
            rf'("{re.escape(aid)}"\s*:\s*\{{\s*\n\s*"src"\s*:\s*")([^"]*)(")', text)
        if m:
            if m.group(2) != src:
                text = text[:m.start(2)] + src + text[m.end(2):]
                updated.append(aid)
            continue

        # 不存在 -> 插到该区块开头
        sm = re.search(rf'(\n  "{section}"\s*:\s*\{{\n)', text)
        if not sm:
            continue
        block = f'    "{aid}": {{\n      "src": "{src}"\n    }},\n'
        text = text[:sm.end(1)] + block + text[sm.end(1):]
        added.append(aid)

    # 落盘前先解析一次,坏了就不写(宁可报错也不能写出破 JSON)
    try:
        json.loads(text)
    except json.JSONDecodeError as ex:
        return {"ok": False, "error": f"生成的 JSON 非法,已放弃写入: {ex}",
                "backup": str(backup)}

    AUDIO_CONFIG.write_text(text, encoding="utf-8")
    return {"ok": True, "added": added, "updated": updated, "backup": str(backup)}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def handle_one_request(self):
        """浏览器取消请求(切歌、关窗、重载)会把连接直接掐掉。
        stdlib 默认会把它当未捕获异常打整段 traceback,刷屏且吓人——这里咽掉。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    # -------- helpers
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, download=False):
        if not path.exists() or not path.is_file():
            self._json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "none")
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition",
                             f'attachment; filename="{path.name}"')
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # -------- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path

        if p in ("/", "/index.html"):
            return self._file(STATIC / "app.html")
        if p.startswith("/static/"):
            f = safe_under(STATIC, p[len("/static/"):])
            return self._file(f) if f else self._json({"error": "bad path"}, 400)
        if p == "/api/library":
            return self._json(self.library())
        if p == "/api/edits":
            return self._json(load_edits())
        if p.startswith("/media/"):
            rest = p[len("/media/"):]
            src, _, rel = rest.partition("/")
            root = SOURCES.get(src)
            if not root:
                return self._json({"error": "bad source"}, 400)
            f = safe_under(root, urllib.parse.unquote(rel))
            return self._file(f) if f else self._json({"error": "bad path"}, 400)
        if p.startswith("/preview/"):
            f = safe_under(CACHE, p[len("/preview/"):])
            return self._file(f) if f else self._json({"error": "bad path"}, 400)
        if p == "/api/export/plan":
            return self._json(self.export_plan())
        return self._json({"error": "not found"}, 404)

    # -------- POST
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p == "/api/edits":
            try:
                save_edits(json.loads(self._body().decode("utf-8")))
                return self._json({"ok": True})
            except Exception as ex:
                return self._json({"ok": False, "error": str(ex)}, 400)
        if p == "/api/import":
            return self._json(self.do_import())
        if p == "/api/render":
            return self._json(self.do_render())
        if p == "/api/export":
            return self._json(self.do_export())
        return self._json({"error": "not found"}, 404)

    # -------- 业务
    def library(self) -> dict:
        edits = load_edits()
        items = []
        for src, root in SOURCES.items():
            if not root.exists():
                continue
            for f in sorted(root.rglob("*")):
                if not f.is_file() or f.suffix.lower() not in AUDIO_EXT:
                    continue
                rel = f.relative_to(root).as_posix()
                key = f"{src}/{rel}"
                ed = edits.get(key, {})
                items.append({
                    "key": key, "source": src, "rel": rel,
                    "name": f.name, "stem": f.stem,
                    "group": rel.rsplit("/", 1)[0] if "/" in rel else "",
                    "size": f.stat().st_size,
                    "url": f"/media/{src}/{urllib.parse.quote(rel)}",
                    "edited": bool(ed) and any(
                        ed.get(k) for k in
                        ("trim", "fadeIn", "fadeOut", "gainDb", "normalize", "reverse")),
                    "marked": bool(ed.get("export")),
                    "category": ed.get("category") or guess_category(key),
                    "audio_id": ed.get("audio_id") or default_export_id(key),
                })
        return {"items": items, "sources": list(SOURCES)}

    def do_import(self) -> dict:
        name = urllib.parse.unquote(self.headers.get("X-Filename") or "")
        name = Path(name).name
        if not name or Path(name).suffix.lower() not in AUDIO_EXT:
            return {"ok": False, "error": f"不支持的文件: {name}"}
        IMPORTED.mkdir(parents=True, exist_ok=True)
        dst = IMPORTED / name
        i = 1
        while dst.exists():
            dst = IMPORTED / f"{Path(name).stem}_{i}{Path(name).suffix}"
            i += 1
        dst.write_bytes(self._body())
        return {"ok": True, "key": f"imported/{dst.name}",
                "url": f"/media/imported/{urllib.parse.quote(dst.name)}"}

    def _resolve(self, key: str) -> Path | None:
        src, _, rel = key.partition("/")
        root = SOURCES.get(src)
        return safe_under(root, rel) if root else None

    def do_render(self) -> dict:
        req = json.loads(self._body().decode("utf-8"))
        key = req.get("key", "")
        src = self._resolve(key)
        if not src or not src.exists():
            return {"ok": False, "error": f"找不到源文件: {key}"}
        ed = req.get("edits") or {}
        CACHE.mkdir(parents=True, exist_ok=True)
        out = CACHE / f"prev_{abs(hash((key, json.dumps(ed, sort_keys=True))))}{src.suffix}"
        ok, err = render(src, ed, out)
        if not ok:
            return {"ok": False, "error": err}
        return {"ok": True, "url": f"/preview/{out.name}?t={int(time.time())}",
                "duration": ffprobe_duration(out)}

    def _export_entries(self) -> list[dict]:
        edits = load_edits()
        out = []
        for key, ed in edits.items():
            if not ed.get("export"):
                continue
            src = self._resolve(key)
            if not src or not src.exists():
                continue
            cat = ed.get("category") or guess_category(key)
            aid = ed.get("audio_id") or default_export_id(key)
            ext = ".mp3" if cat in ("bgm", "ambient") else ".wav"
            fname = f"{aid}{ext}"
            out.append({
                "key": key, "src_path": src, "category": cat, "audio_id": aid,
                "filename": fname,
                "dst_path": PROJECT_AUDIO / EXPORT_SUBDIR / fname,
                "src": f"/resources/runtime/audio/{EXPORT_SUBDIR}/{fname}",
                "edits": ed,
            })
        return out

    def export_plan(self) -> dict:
        entries = self._export_entries()
        dupes = {}
        for e in entries:
            dupes.setdefault(e["audio_id"], []).append(e["key"])
        conflicts = {k: v for k, v in dupes.items() if len(v) > 1}
        cfg = audio_config_plan(entries) if entries else []
        return {
            "count": len(entries),
            "dir": str((PROJECT_AUDIO / EXPORT_SUBDIR).relative_to(REPO)),
            "config": str(AUDIO_CONFIG.relative_to(REPO)),
            "files": [{"audio_id": e["audio_id"], "category": e["category"],
                       "filename": e["filename"], "from": e["key"],
                       "exists": e["dst_path"].exists()} for e in entries],
            "config_changes": cfg,
            "conflicts": conflicts,
        }

    def do_export(self) -> dict:
        req = json.loads(self._body().decode("utf-8") or "{}")
        write_config = bool(req.get("write_config", True))
        entries = self._export_entries()
        if not entries:
            return {"ok": False, "error": "没有勾选要导出的音频(在条目上点「导出」)"}
        dupes = {}
        for e in entries:
            dupes.setdefault(e["audio_id"], []).append(e["key"])
        conflicts = {k: v for k, v in dupes.items() if len(v) > 1}
        if conflicts:
            return {"ok": False, "error": "有重名的导出 id,先改掉再导出",
                    "conflicts": conflicts}

        rendered, failed = [], []
        for e in entries:
            ok, err = render(e["src_path"], e["edits"], e["dst_path"])
            (rendered if ok else failed).append(
                {"audio_id": e["audio_id"], "file": e["filename"], "error": err})
        result = {"ok": not failed, "rendered": len(rendered),
                  "failed": failed,
                  "dir": str((PROJECT_AUDIO / EXPORT_SUBDIR).relative_to(REPO))}
        if write_config and rendered:
            done_ids = {r["audio_id"] for r in rendered}
            result["config"] = audio_config_apply(
                [e for e in entries if e["audio_id"] in done_ids])
        return result


def main() -> None:
    for d in (IMPORTED, CACHE):
        d.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"音频编辑器: {url}\n源目录: " +
          ", ".join(f"{k}={v}" for k, v in SOURCES.items()) +
          "\n(Ctrl+C 停止)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
