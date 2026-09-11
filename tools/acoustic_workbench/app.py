# -*- coding: utf-8 -*-
"""声学工作台——桌面壳。

壳本身在 `tools/desktop_shell.py`（临时端口、daemon 服务线程、单实例、三层灭浏览器缓存）。
这里只负责"我是谁"：handler、窗口标题、单实例标识，以及 ``--open <id>``：
首个实例把 id 塞给 ``/api/boot``；已有实例在跑时把 ``open:<id>`` 送过命名管道。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_ID = "gamedraft-acoustic-workbench"
TITLE = "声学工作台 · 场景回音"


def main(port: int | None = None, smoke: bool = False, open_id: str = "", selftest: str = "",
         game_url: str = "") -> int:
    if selftest or smoke:
        # offscreen 下 QtWebEngine 默认拿不到 WebGL2；ANGLE + SwiftShader 就能起来（轨迹工作台同款）
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                              "--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from tools.desktop_shell import run_desktop
    from tools.acoustic_workbench import serve

    if game_url:
        serve.LINK.set_base(game_url)
    elif selftest:
        # 自检绝不碰真在跑的游戏：它会往槽里发临时空间、发试听，正在预览的人会听到 / 看到它。指到一个死端口
        serve.LINK.set_base("http://127.0.0.1:9")
    if open_id:
        serve.BOOT_OPEN.append(open_id)
    if selftest:
        path = Path(selftest)
        if not path.is_absolute():
            path = ROOT / path
        return run_desktop(handler_cls=serve.H, title=TITLE + "（自检）", app_id=APP_ID + "-selftest", port=port,
                           selftest=str(path))

    def _on_activate(data: bytes, view) -> None:
        if data.startswith(b"open:"):
            sid = data[5:].decode("utf-8", "replace").strip()
            if sid and view is not None:
                view.page().runJavaScript(f"window.__openSpace && window.__openSpace({json.dumps(sid)})")

    payload = f"open:{open_id}".encode("utf-8") if open_id else b"raise"
    return run_desktop(handler_cls=serve.H, title=TITLE, app_id=APP_ID, port=port, smoke=smoke,
                       on_activate=_on_activate, activate_payload=payload)


if __name__ == "__main__":
    sys.exit(main(smoke="--smoke" in sys.argv))
