# -*- coding: utf-8 -*-
"""粒子工作台——桌面壳。

壳本身在 ``tools/desktop_shell.py``（临时端口、daemon 服务线程、单实例、三层灭浏览器缓存）。
这里只负责"我是谁"：handler、窗口标题、单实例标识，以及 ``--open <id>``：
首个实例把 id 塞给 ``/api/boot``；已有实例在跑时把 ``open:<id>`` 送过命名管道。
"""
from __future__ import annotations

import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_ID = "gamedraft-vfx-workbench"
TITLE = "粒子工作台 · 世界空间粒子 / 群体"


@contextmanager
def selftest_sandbox() -> Iterator[Path]:
    """自检 / 真 GPU 对照的读写沙箱（桌面壳自检与 ``--serve --selftest-sandbox`` 共用）：

    * 游戏地址钉在死端口 ``127.0.0.1:9``（自检会往槽里发临时效果、发刺激，正在预览的人会看到它）；
    * 布置库拷一份到临时目录，整个进程的布置读写都指过去（页面经 ``/api/boot`` 的 ``placements.real`` 自证）；
    * 雷电样式库同理（真效果据此仍判「最新」；自检里套用样式只会写临时库和 ``zz_selftest_*`` 效果）。
    退出时指回真库、删掉临时目录。效果资产目录照旧是真的：自检只建 / 删 ``zz_selftest_*``，pytest 那侧比真库的字节。
    """
    import shutil
    import tempfile
    from tools.editor.shared import vfx_placements as vp
    from tools.vfx_workbench import lightning, placements, serve

    serve.LINK.set_base("http://127.0.0.1:9")
    tmp = Path(tempfile.mkdtemp(prefix="vfxwb_selftest_"))
    saved_ls = lightning.LIB_PATH
    try:
        real = vp.library_path(ROOT)
        fake = vp.library_path(tmp)
        fake.parent.mkdir(parents=True, exist_ok=True)
        if real.is_file():
            fake.write_bytes(real.read_bytes())
        placements.LIB_ROOT = tmp
        if lightning.LIB_PATH.is_file():
            shutil.copyfile(lightning.LIB_PATH, tmp / "vfx_lightning_styles.json")
        lightning.LIB_PATH = tmp / "vfx_lightning_styles.json"
        yield tmp
    finally:
        placements.LIB_ROOT = ROOT
        lightning.LIB_PATH = saved_ls
        shutil.rmtree(tmp, ignore_errors=True)


def main(port: int | None = None, smoke: bool = False, open_id: str = "", selftest: str = "",
         game_url: str = "") -> int:
    if selftest or smoke:
        # offscreen 下 QtWebEngine 默认拿不到 WebGL2（3D 视图要它）；ANGLE + SwiftShader 就能起来（两台工作台同款）。
        # 原画视图 / 雷预览走 WebGPU：offscreen 的 QtWebEngine 拿不到适配器，自检里那几条记 SKIP（真 GPU 的 Chrome 另跑一遍）
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                              "--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from tools.desktop_shell import run_desktop
    from tools.vfx_workbench import serve

    if game_url:
        serve.LINK.set_base(game_url)
    if open_id:
        serve.BOOT_OPEN.append(open_id)
    if selftest:
        path = Path(selftest)
        if not path.is_absolute():
            path = ROOT / path
        # 自检绝不写真实的布置库 / 样式库、绝不碰真在跑的游戏（见 selftest_sandbox）
        with selftest_sandbox():
            return run_desktop(handler_cls=serve.H, title=TITLE + "（自检）", app_id=APP_ID + "-selftest", port=port,
                               selftest=str(path))

    def _on_activate(data: bytes, view) -> None:
        if data.startswith(b"open:"):
            eid = data[5:].decode("utf-8", "replace").strip()
            if eid and view is not None:
                view.page().runJavaScript(f"window.__openEffect && window.__openEffect({json.dumps(eid)})")

    payload = f"open:{open_id}".encode("utf-8") if open_id else b"raise"
    return run_desktop(handler_cls=serve.H, title=TITLE, app_id=APP_ID, port=port, smoke=smoke,
                       on_activate=_on_activate, activate_payload=payload)


if __name__ == "__main__":
    sys.exit(main(smoke="--smoke" in sys.argv))
