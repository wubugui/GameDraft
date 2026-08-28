"""开机自启动的注册与撤销。

## 为什么必须有这个

调度是"工作台开着才构建"（不注册系统计划任务）。那么"定期自动构建"要真的成立，
工作台就得**开机自己起来并待在托盘里**——否则每次重启机器都要记得手工打开它，
自动化立刻退化成"想起来才有"。

## 怎么做

Windows：写 `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`。
选它而不是「启动」文件夹或计划任务，理由：

* **不需要管理员**（HKCU 是当前用户自己的键），也不碰系统级设置；
* 用户随时能在「任务管理器 → 启动应用」里看到并自行禁用——不搞用户看不见的自启；
* 一个字符串值就是全部足迹，撤销就是删掉它，不留残留。

其它平台暂不支持：报出来，不假装成功。
"""
from __future__ import annotations

import sys
from pathlib import Path

#: 注册表里的值名。改它等于换一条自启项，旧的会残留，别改。
RUN_VALUE_NAME = "GameDraftBuildWorkbench"
_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def is_supported() -> bool:
    return sys.platform == "win32"


def _pythonw_for(exe: str) -> str:
    """尽量用 pythonw 起：控制台窗口对一个常驻托盘的东西是纯噪音。

    找不到 pythonw 就退回 python——**宁可多一个黑窗口，也不要起不来**。
    """
    p = Path(exe)
    if p.name.lower() == "python.exe":
        candidate = p.with_name("pythonw.exe")
        if candidate.is_file():
            return str(candidate)
    return exe


def launch_argv(project_root: Path, python_exe: str | None = None) -> list[str]:
    """启动工作台的 argv。

    **怎么启动自己这件事只写在这一处。** 主编辑器的按钮、开机自启项都从这里取，
    免得哪天改了入口只改到一半（比如自启还用着旧的模块名）。

    再启动一次是安全的：工作台自带单实例守卫，第二个进程会把第一个唤到前台
    然后自己退出（见 `single_instance.py`）。
    """
    return [_pythonw_for(python_exe or sys.executable), "-m", "tools.build_workbench",
            str(project_root)]


def build_command(project_root: Path, python_exe: str | None = None) -> str:
    """自启动要执行的命令行（已按 Windows 规则加好引号）。"""
    exe, *rest = launch_argv(project_root, python_exe)
    # 只给路径类参数加引号；`-m tools.build_workbench` 不含空格，加了反而难读
    return f'"{exe}" {rest[0]} {rest[1]} "{rest[2]}"'


def current_command() -> str | None:
    """当前注册的自启命令；没注册返回 None。"""
    if not is_supported():
        return None
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, RUN_VALUE_NAME)
            return str(value)
    except OSError:
        return None


def is_enabled_for(project_root: Path, python_exe: str | None = None) -> bool:
    """自启是否已注册**且指向这个工程**。

    指向别的工程时算"没开"——否则换个检出打开工作台，勾选框会显示成开着，
    而真正开机起来的是另一份仓库，非常难查。
    """
    cur = current_command()
    return cur is not None and cur == build_command(project_root, python_exe)


def set_enabled(project_root: Path, enabled: bool, python_exe: str | None = None) -> tuple[bool, str]:
    """开/关自启。返回 (成功, 说给人听的一句话)。"""
    if not is_supported():
        return False, f"这个平台（{sys.platform}）暂不支持开机自启动"
    import winreg
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                cmd = build_command(project_root, python_exe)
                winreg.SetValueEx(key, RUN_VALUE_NAME, 0, winreg.REG_SZ, cmd)
                return True, f"已设为开机自启：{cmd}"
            try:
                winreg.DeleteValue(key, RUN_VALUE_NAME)
            except FileNotFoundError:
                pass  # 本来就没注册 = 已经是想要的状态
            return True, "已取消开机自启"
    except OSError as e:
        return False, f"改注册表失败（{e}）"
