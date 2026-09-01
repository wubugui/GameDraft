"""角色照明实验室——桌面壳。

壳本身在 `tools/desktop_shell.py`(与场景重打光工作台共用一份):
临时端口、daemon 服务线程、单实例、三层灭浏览器缓存,细节见那边的模块注释。

⚠ 本工具比重打光工作台多一类残留源:烘焙是 `subprocess.Popen(pipeline.py)`
起的**子进程**(一跑 3 分钟),装 torch 那条也是。daemon 线程会随父进程消失,
子进程不会 —— 关窗口后它会继续吃 CPU、继续往 `out/` 和 `runtime/` 里写,
下次再烘同一个场景就是**两个进程并发写同一批产物且都合法**。
两处 `Popen` 已统一走 `tools.child_jobs.spawn`(Windows Job Object,
父进程无论怎么死内核都杀光整棵树)。

⚠ **`--smoke` 必须在有 GPU 的真窗口下跑**,不能加 `QT_QPA_PLATFORM=offscreen`。
本页面要建 16 个 WebGL2 程序,offscreen 的软件 GL 撑不起来
(`Failed to make current since context is marked as lost`),`loadFinished` 永远不来、
自检超时——那不是回归。重打光工作台的页面是纯 2D canvas,所以它 offscreen 也能过,
两者不可类比。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(port: int | None = None, smoke: bool = False) -> int:
    from tools.character_lighting_lab.serve import H
    from tools.desktop_shell import run_desktop
    return run_desktop(handler_cls=H, title='角色照明实验室 · 光照烘焙',
                       app_id='gamedraft-char-lighting-lab', port=port, smoke=smoke)


if __name__ == '__main__':
    sys.exit(main(smoke='--smoke' in sys.argv))
