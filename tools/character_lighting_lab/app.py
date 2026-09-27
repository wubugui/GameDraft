"""角色照明实验室——桌面壳。

壳本身在 `tools/desktop_shell.py`(与场景重打光工作台共用一份):
临时端口、daemon 服务线程、单实例、三层灭浏览器缓存,细节见那边的模块注释。

⚠ 本工具比重打光工作台多一类残留源:烘焙是 `subprocess.Popen(pipeline.py)`
起的**子进程**(一跑 3 分钟),装 torch 那条也是。daemon 线程会随父进程消失,
子进程不会 —— 关窗口后它会继续吃 CPU、继续往 `out/` 和 `runtime/` 里写,
下次再烘同一个场景就是**两个进程并发写同一批产物且都合法**。
两处 `Popen` 已统一走 `tools.child_jobs.spawn`(Windows Job Object,
父进程无论怎么死内核都杀光整棵树)。

画面走引擎 RHI(只有 WebGPU:2D = 游戏的渲染器 + 角色受光 / 深度遮挡,3D = 工作台 3D 调试件),
所以壳开 `webgpu=True`(网页视图换成 `tools.qt_webgpu.WebGpuView`;离屏平台下 smoke / selftest
改开屏幕外的真窗口)。这个窗口拿不到 WebGPU 时画面区写原因,烘焙 / 导出 / 编辑照常。

`--selftest <js>`:把页内自检(`viewer/tests/selftest.js`)注入真页面跑完即退(有 FAIL / EXC 退出码 1)。
自检只动视图参数,不点烘焙 / 导出 / 存盘,读的是真工程已烘的场景。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SELFTEST_JS = Path(__file__).resolve().parent / 'viewer' / 'tests' / 'selftest.js'


def main(port: int | None = None, smoke: bool = False, selftest: str = '') -> int:
    from tools.character_lighting_lab.serve import H
    from tools.desktop_shell import run_desktop
    if selftest:
        path = Path(selftest)
        if not path.is_absolute():
            path = ROOT / path
        return run_desktop(handler_cls=H, title='角色照明实验室 · 光照烘焙(自检)',
                           app_id='gamedraft-char-lighting-lab-selftest', port=port,
                           selftest=str(path), webgpu=True)
    return run_desktop(handler_cls=H, title='角色照明实验室 · 光照烘焙',
                       app_id='gamedraft-char-lighting-lab', port=port, smoke=smoke, webgpu=True)


if __name__ == '__main__':
    sys.exit(main(smoke='--smoke' in sys.argv,
                  selftest=str(SELFTEST_JS) if '--selftest' in sys.argv else ''))
