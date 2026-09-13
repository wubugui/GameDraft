---
target: editor-change-verification-gate
date: 2026-09-12
session: 手持光源（火把）编辑器侧
---

现象: 验收门与 editor-tools norms 都写「`./dev.sh validate-data` 零 error」；本工作树的**起点**就是 42 error / 281 warning（全来自并行会话正在改的东西：eco_眼力 叙事图缺失、几个夜背景尺寸失配、崖墓烘焙哈希失配），"零 error"这条门在多会话并行的树上不可达，只能改成「改动前后 error/warning **集合**差异为空」。
证据: `.tools/venv/Scripts/python.exe -m tools.dev validate-data` 改动前后都是 `[validate] 42 error(s), 281 warning(s).`，`diff` 两边的 `[ERR ]` / `[WARN]` 行集合为空；另 `./dev.sh` 在 Windows 上直接退出（它找 `.tools/venv/bin/python`，本机是 `Scripts/`）。
建议: 门的判据那一节把「零 error」改成「与改动前的 error/warning 集合一致（只减不增）」并给出集合 diff 的命令；平台差异那一节补一行「`./dev.sh` 在 Windows 不可用，走 `sh scripts/py.sh -m tools.dev <task>`」。
