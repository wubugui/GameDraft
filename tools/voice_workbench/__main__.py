"""启动配音工作台:``sh scripts/py.sh -m tools.voice_workbench``

也可以只用内核不开界面(批处理/脚本化):
    from tools.voice_workbench import library, project, render
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


def main() -> int:
    from PySide6.QtWidgets import QApplication

    from tools.voice_workbench.ui import VoiceWorkbench

    app = QApplication.instance() or QApplication(sys.argv)
    try:
        from tools.editor import theme as app_theme

        app_theme.apply_application_theme(app, app_theme.current_theme_id())
    except Exception:                      # noqa: BLE001 - 主题装不上不该拦住工具启动
        pass
    win = VoiceWorkbench(REPO)
    win.show()
    # 恢复上次会话放在 show() 之后：它可能弹"要不要恢复自动存盘"，
    # 构造期弹模态框会在离屏环境永不返回（测试挂死过一次）
    win.restore_session()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
