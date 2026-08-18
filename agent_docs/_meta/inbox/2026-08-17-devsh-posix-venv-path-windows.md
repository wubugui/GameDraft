现象：Windows 本机 `sh dev.sh validate-data` 直接退出「Project venv missing」——dev.sh 硬编码 `.tools/venv/bin/python`（POSIX 布局），本机 venv 在 `.tools/venv/Scripts/python.exe`。
与库内认知的冲突：runtime/editor 验收门与验证门配方都写 `./dev.sh validate-data`，Windows 上该入口整个不可用（不是慢/不稳，是零启动）。
处置：等价替代 `.tools/venv/Scripts/python.exe -m tools.dev validate-data` 实测可用（本次人物簿 portrait 改动即以此跑门）；dev.sh 是否加 Scripts 回落属跨平台小修，未在本次改（限定文件之外）。
