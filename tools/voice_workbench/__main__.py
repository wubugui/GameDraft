"""启动配音工作台:``sh scripts/py.sh -m tools.voice_workbench [仓库根]``

主编辑器的「Tools → External tools」也从这里起,并把**当前打开的工程根**当参数传进来:
不传就按本文件的位置推,那在"编辑器开着另一个工程"时会指错地方(源库与导出目录
都是相对仓库根算的)。**只有仓库根跟着参数走**——工程文件与界面状态仍留在工具目录下,
那是工具自己的家当,不该随打开哪个工程而变。

也可以只用内核不开界面(批处理/脚本化):
    from tools.voice_workbench import library, project, render
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


def _repo_root_from_argv(argv: list[str]) -> Path:
    """命令行给了存在的目录就用它,否则按本文件位置推。**不认不存在的路径**——
    静默回落好过用一个错的根去扫源库(扫出空列表,看起来像"素材全没了")。"""
    for arg in argv[1:]:
        if arg and not arg.startswith("-") and Path(arg).is_dir():
            return Path(arg).resolve()
    return REPO


def main() -> int:
    from PySide6.QtWidgets import QApplication

    from tools.voice_workbench.ui import VoiceWorkbench

    app = QApplication.instance() or QApplication(sys.argv)
    try:
        from tools.editor import theme as app_theme

        app_theme.apply_application_theme(app, app_theme.current_theme_id())
    except Exception:                      # noqa: BLE001 - 主题装不上不该拦住工具启动
        pass
    win = VoiceWorkbench(_repo_root_from_argv(sys.argv))
    win.show()
    # 恢复上次会话放在 show() 之后：它可能弹"要不要恢复自动存盘"，
    # 构造期弹模态框会在离屏环境永不返回（测试挂死过一次）
    win.restore_session()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
