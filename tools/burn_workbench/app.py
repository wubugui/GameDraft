# -*- coding: utf-8 -*-
"""燃烧工作台——桌面壳。

壳本身在 ``tools/desktop_shell.py``（临时端口、daemon 服务线程、单实例、三层禁缓存、关窗 / 刷新前问未保存）。
这里只管"我是谁"：handler、窗口标题、单实例标识，以及 ``--open <id>``（首个实例塞给 ``/api/boot``；
已有实例在跑时把 ``open:<id>`` 送过命名管道，已开着的窗口切到那份可燃物）。

``--selftest``：**整个进程的读写都指到临时样例工程**（``fixtures.build_project``）——自检只在那里存盘，
游戏地址钉在 ``127.0.0.1:9``（绝不往真在跑的游戏里推东西），跑完连目录删掉。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_ID = "gamedraft-burn-workbench"
TITLE = "燃烧工作台 · 可燃物模板"


def main(port: int | None = None, smoke: bool = False, open_id: str = "", selftest: str = "", game_url: str = "") -> int:
    if selftest or smoke:
        # offscreen 下 QtWebEngine 默认拿不到 WebGL2；ANGLE + SwiftShader 就能起来（与粒子 / 轨迹台同款）
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                              "--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from tools.burn_workbench import serve, store
    from tools.desktop_shell import run_desktop

    if game_url:
        serve.LINK.set_base(game_url)
    elif selftest:
        serve.LINK.set_base("http://127.0.0.1:9")
    if open_id:
        serve.BOOT_OPEN.append(open_id)
    if selftest:
        import shutil
        import tempfile
        from tools.burn_workbench import fixtures
        path = Path(selftest)
        if not path.is_absolute():
            path = ROOT / path
        tmp = Path(tempfile.mkdtemp(prefix="burnwb_selftest_"))
        try:
            fixtures.build_project(tmp)
            store.PROJECT = tmp
            store.DATA = tmp
            if not open_id:
                serve.BOOT_OPEN.append("paper_pile")
            return run_desktop(handler_cls=serve.H, title=TITLE + "（自检）", app_id=APP_ID + "-selftest", port=port,
                               selftest=str(path))
        finally:
            store.PROJECT = store.ROOT
            store.DATA = store.ROOT
            shutil.rmtree(tmp, ignore_errors=True)

    def _on_activate(data: bytes, view) -> None:
        if data.startswith(b"open:"):
            bid = data[5:].decode("utf-8", "replace").strip()
            if bid and view is not None:
                view.page().runJavaScript(f"window.__openBurnable && window.__openBurnable({json.dumps(bid)})")

    payload = f"open:{open_id}".encode("utf-8") if open_id else b"raise"
    return run_desktop(handler_cls=serve.H, title=TITLE, app_id=APP_ID, port=port, smoke=smoke,
                       on_activate=_on_activate, activate_payload=payload)


if __name__ == "__main__":
    sys.exit(main(smoke="--smoke" in sys.argv))
