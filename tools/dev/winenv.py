"""Windows registry environment fallbacks (no-ops on other platforms).

Legacy installs stored OSS keys / GAMEDRAFT_GIT_PROXY in the Windows User
scope (HKCU\\Environment) via ``[Environment]::SetEnvironmentVariable(...,
"User")``. Reading keeps them working; new writes go elsewhere (.tools/oss.env).
"""

from __future__ import annotations

import sys


def read_user_env(name: str) -> str | None:
    if sys.platform != "win32":
        return None
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
    except OSError:
        return None
    return str(value) if value else None


def read_machine_env(name: str) -> str | None:
    if sys.platform != "win32":
        return None
    import winreg

    path = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            value, _ = winreg.QueryValueEx(key, name)
    except OSError:
        return None
    return str(value) if value else None
