---
target: editor-tools-norms
date: 2026-09-11
session: 粒子工作台（tools/vfx_workbench）落地
---

现象: 三台工作台的「打包运行时模块给页面」都往工作树里的 `viewer/_gen/` 写，而 pytest 进程装着
`tools/testing/repo_write_guard.py` 的仓库写守卫 —— 在 pytest 里直接调 `bundle.ensure_bundle(force=True)`
必被 `RepositoryWriteBlocked` 拦死（轨迹 / 声学两台从来没给 bundle 写过测试，所以这条没人踩到过）。
证据: `sh scripts/py.sh -m pytest tools/vfx_workbench -q` 首轮红在
`RepositoryWriteBlocked: event=open, path=...\tools\vfx_workbench\viewer\_gen\build_bundle.cjs`；
改成子进程 `python -m tools.vfx_workbench --bundle` 打、本进程只读产物后全绿（见
`tools/vfx_workbench/tests/test_bundle.py` 文件头）。
建议: 在 editor-tools 的验证门配方里写一句「派生产物落工作树内的工具，打包一律走子进程，
pytest 进程只读产物 + 断言缓存不重打」——顺带那条缓存断言正好被守卫背书（真重打就会被拦）。
