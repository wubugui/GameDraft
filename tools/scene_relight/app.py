"""场景重打光工作台——桌面壳。

壳本身在 `tools/desktop_shell.py`(2026-08-31 提成共用,角色照明实验室同用一份):
临时端口、daemon 服务线程、单实例、三层灭浏览器缓存,细节见那边的模块注释。
这里只负责"我是谁":handler、窗口标题、单实例标识。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(port: int | None = None, smoke: bool = False) -> int:
    from tools.desktop_shell import run_desktop
    from tools.scene_relight.serve import H
    return run_desktop(handler_cls=H, title='场景重打光工作台',
                       app_id='gamedraft-scene-relight', port=port, smoke=smoke)


if __name__ == '__main__':
    sys.exit(main(smoke='--smoke' in sys.argv))
