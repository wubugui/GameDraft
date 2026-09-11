# -*- coding: utf-8 -*-
"""CLI:

  python -m tools.handbook                    # 起本地站(改 md 即时刷新)并用默认浏览器打开
  python -m tools.handbook --no-open          # 只起服务
  python -m tools.handbook --port 5344        # 换端口
  python -m tools.handbook --build            # 静态导出到 handbook/site/,不起服务(整个文件夹拷走就能看)
  python -m tools.handbook --build -d 目录     # 导出到别处

正文在 handbook/docs/*.md;写什么由制作人决定。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.handbook import (  # noqa: E402
    CONFIG_PATH,
    DEFAULT_HOST,
    DEFAULT_PORT,
    SITE_DIR,
    build_argv,
    child_env,
    handbook_url,
    is_handbook_serving,
    missing_dependency_hint,
    serve_argv,
    wait_until_listening,
)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="handbook", description="GameDraft 手册(本地文档站)")
    ap.add_argument("--build", action="store_true", help="只做静态导出,不起服务")
    ap.add_argument("-d", "--site-dir", default="", help="导出目录(默认 handbook/site/)")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true", help="起服务但不开浏览器")
    ap.add_argument("--no-livereload", action="store_true", help="关掉改 md 自动刷新")
    args = ap.parse_args(argv)

    if not CONFIG_PATH.is_file():
        print(f"[handbook] 找不到 {CONFIG_PATH}", file=sys.stderr)
        return 2
    hint = missing_dependency_hint()
    if hint:
        print(f"[handbook] {hint}", file=sys.stderr)
        return 3

    if args.build:
        site = Path(args.site_dir).resolve() if args.site_dir else SITE_DIR
        rc = subprocess.call(build_argv(sys.executable, CONFIG_PATH, site), cwd=str(ROOT), env=child_env())
        if rc == 0:
            print(f"[handbook] 已导出:{site}  (双击 index.html 可翻页;要搜索就在该目录起任意 http 服务)")
        return rc

    url = handbook_url(args.host, args.port)
    if is_handbook_serving(url):
        print(f"[handbook] 手册已在 {url} 运行,直接打开")
        if not args.no_open:
            webbrowser.open(url)
        return 0

    cmd = serve_argv(sys.executable, CONFIG_PATH, host=args.host, port=args.port,
                     livereload=not args.no_livereload)
    print(f"[handbook] 起站:{' '.join(cmd)}")
    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=child_env())
    try:
        if not wait_until_listening(args.host, args.port, proc):
            code = proc.poll()
            print(f"[handbook] 服务没起来(mkdocs 退出码 {code});上面是它的输出" if code is not None
                  else "[handbook] 等端口超时", file=sys.stderr)
            if code is None:
                proc.terminate()
            return 1
        print(f"[handbook] {url}  (Ctrl+C 停)")
        if not args.no_open:
            webbrowser.open(url)
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
