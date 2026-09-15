# -*- coding: utf-8 -*-
"""草木工作台——桌面壳。

壳本身在 ``tools/desktop_shell.py``(临时端口、daemon 服务线程、单实例、三层灭浏览器缓存)。
这里只负责"我是谁":handler、窗口标题、单实例标识,以及 ``--open <场景 id>``。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_ID = "gamedraft-sway-workbench"
TITLE = "草木工作台 · 抠植被 / 标刚体 / 推给游戏"


def main(port: int | None = None, smoke: bool = False, open_id: str = "", selftest: str = "") -> int:
    if selftest or smoke:
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                              "--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from tools.desktop_shell import run_desktop
    from tools.sway_workbench import serve

    if open_id:
        serve.BOOT_OPEN.append(open_id)
    if selftest:
        path = Path(selftest)
        if not path.is_absolute():
            path = ROOT / path
        # 自检绝不碰作者的真草稿(local/sway_drafts/):整个进程的草稿读写指到临时目录,跑完连目录删掉
        # 推过的预览(local/sway_preview/)同理:丢弃改动的路径会去撤预览(删目录 + 通知游戏),指到空的临时目录
        # ⇒ 服务端看到"没有推过的预览"就回,既删不到作者的真预览、也不会去碰真游戏
        import shutil
        import tempfile
        from tools.sway_workbench import layers
        tmp = Path(tempfile.mkdtemp(prefix="swaywb_selftest_"))
        keep_preview = layers.PREVIEW_ROOT
        layers.DRAFT_ROOT = tmp
        layers.PREVIEW_ROOT = tmp / "sway_preview"
        try:
            return run_desktop(handler_cls=serve.H, title=TITLE + "(自检)", app_id=APP_ID + "-selftest", port=port,
                               selftest=str(path))
        finally:
            layers.DRAFT_ROOT = ROOT / "local" / "sway_drafts"
            layers.PREVIEW_ROOT = keep_preview
            shutil.rmtree(tmp, ignore_errors=True)

    def _on_activate(data: bytes, view) -> None:
        if data.startswith(b"open:"):
            sid = data[5:].decode("utf-8", "replace").strip()
            if sid and view is not None:
                view.page().runJavaScript(f"window.__openScene && window.__openScene({json.dumps(sid)})")

    payload = f"open:{open_id}".encode("utf-8") if open_id else b"raise"
    return run_desktop(handler_cls=serve.H, title=TITLE, app_id=APP_ID, port=port, smoke=smoke,
                       on_activate=_on_activate, activate_payload=payload)


if __name__ == "__main__":
    sys.exit(main(smoke="--smoke" in sys.argv))
