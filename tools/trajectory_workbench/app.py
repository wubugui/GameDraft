# -*- coding: utf-8 -*-
"""轨迹工作台——桌面壳。

壳本身在 `tools/desktop_shell.py`（临时端口、daemon 服务线程、单实例、三层灭浏览器缓存）。
这里只负责"我是谁"：handler、窗口标题、单实例标识，以及 ``--open <id>``：
首个实例把 id 塞给 ``/api/boot``；已有实例在跑时把 ``open:<id>`` 送过命名管道，
让它的页面直接切到那条资产。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_ID = "gamedraft-trajectory-workbench"
TITLE = "轨迹工作台 · 实体轨迹动画"


def main(port: int | None = None, smoke: bool = False, open_id: str = "", selftest: str = "") -> int:
    if selftest:
        # offscreen 下 QtWebEngine 默认拿不到 WebGL2（3D 视图整块被跳过）。ANGLE + 只给 WebGL 用的
        # SwiftShader 就能起来（实测 PySide6 6.11 / Chromium 140），没显卡的 CI 机也一样。
        # 必须在任何 Qt 模块 import 之前设；用户显式设了就不动。
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                              "--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from tools.desktop_shell import run_desktop
    from tools.trajectory_workbench import serve

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
            tid = data[5:].decode("utf-8", "replace").strip()
            if tid and view is not None:
                view.page().runJavaScript(f"window.__openTrajectory && window.__openTrajectory({json.dumps(tid)})")

    payload = f"open:{open_id}".encode("utf-8") if open_id else b"raise"
    return run_desktop(handler_cls=serve.H, title=TITLE, app_id=APP_ID, port=port, smoke=smoke,
                       on_activate=_on_activate, activate_payload=payload)


if __name__ == "__main__":
    sys.exit(main(smoke="--smoke" in sys.argv))
