"""入口: 在项目根目录执行 python -m tools.chronicle_sim_v2"""
from __future__ import annotations

import logging
import os

# 须在首次 import pydantic / litellm 之前设置，减少无关控制台告警。
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
# 本机 opentelemetry 与 logfire 的 pydantic 插件版本不一致时会反复 UserWarning，禁用插件即可。
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")
# LiteLLM 拉取 GitHub 价目表失败（网络/代理）时只使用本地备份，不必每次 WARNING。
logging.getLogger("LiteLLM").setLevel(logging.ERROR)


def main() -> None:
    from tools.chronicle_sim_v2.gui.main_window import MainWindow  # noqa: F811
    import sys
    from PySide6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    app.setApplicationName("ChronicleSim v2")
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
