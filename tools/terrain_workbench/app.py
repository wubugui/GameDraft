# -*- coding: utf-8 -*-
"""地形工作台——桌面壳（壳本身在 ``tools/desktop_shell.py``：临时端口、daemon 服务线程、单实例、三层灭浏览器缓存）。

这里只负责"我是谁"：handler、窗口标题、单实例标识，以及 ``--open <场景>``：
首个实例把场景塞给 ``/api/boot``；已有实例在跑时把 ``open:<场景>`` 送过命名管道。

``--selftest`` 绝不碰作者的真作者层：把合成器的场景根指到一个临时树（只拷自检场景的地形 / 碰撞 / 照明 json /
行走面 / 背景），预览与草稿也指到临时目录，游戏地址指到死端口。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_ID = "gamedraft-terrain-workbench"
TITLE = "地形工作台 · 碰撞 / 可走区 / 行走面"
#: 自检用的场景（要有深度 + 照明载荷；bridge_underpass 是几台工作台共用的自检场景）
SELFTEST_SCENE = "bridge_underpass"


def isolate_for_selftest(sid: str, tmp: Path) -> None:
    """把会**写**的根全部指到 ``tmp``：合成器的场景根（只拷自检场景要读的那几样）、预览、草稿。"""
    import shutil
    from tools.character_lighting_lab import terrain_compose as tc
    from tools.terrain_workbench import authoring

    src = tc.SCENES_RT / sid
    dst = tmp / "scenes" / sid
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("terrain", "lighting"):
        if (src / name).is_dir():
            shutil.copytree(src / name, dst / name, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("probes_*", "*.bin", "sway_*", "normal.png", "albedo.png",
                                                          "sky_*", "vol_*", "*.npy", "history"))
    for f in src.iterdir():
        if f.is_file() and (f.suffix.lower() in (".png", ".jpg", ".jpeg", ".json")):
            shutil.copyfile(f, dst / f.name)
    # 自检从**空作者层**起（它按"自己画的是第几块"断言）：真场景的作者层随时会被人 / 批量修碰撞写上东西，
    # 只在临时树里清空，真数据一个字节不动
    tj = dst / "terrain" / tc.TERRAIN_JSON
    if tj.is_file():
        doc = json.loads(tj.read_text(encoding="utf-8"))
        doc.update(regions=[], heightOps=[], brush=None, height=None)
        tj.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        for f in (tc.BRUSH_FILE, tc.HEIGHT_FILE):
            if (dst / "terrain" / f).exists():
                (dst / "terrain" / f).unlink()
    tc.SCENES_RT = tmp / "scenes"
    authoring.PREVIEW_ROOT = tmp / "preview"
    authoring.DRAFT_ROOT = tmp / "drafts"


def main(port: int | None = None, smoke: bool = False, open_id: str = "", selftest: str = "",
         game_url: str = "") -> int:
    if selftest or smoke:
        os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                              "--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader")
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from tools.desktop_shell import run_desktop
    from tools.terrain_workbench import authoring, serve

    if game_url:
        os.environ["GAMEDRAFT_GAME_URL"] = game_url
    if open_id:
        serve.BOOT_OPEN.append(open_id)
    if selftest:
        path = Path(selftest)
        if not path.is_absolute():
            path = ROOT / path
        import shutil
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="terrainwb_selftest_"))
        try:
            isolate_for_selftest(open_id or SELFTEST_SCENE, tmp)
            os.environ["GAMEDRAFT_GAME_URL"] = "http://127.0.0.1:9"
            authoring._PROBE_PORTS = ()
            if not open_id:
                serve.BOOT_OPEN.append(SELFTEST_SCENE)
            return run_desktop(handler_cls=serve.H, title=TITLE + "（自检）", app_id=APP_ID + "-selftest", port=port,
                               selftest=str(path))
        finally:
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
