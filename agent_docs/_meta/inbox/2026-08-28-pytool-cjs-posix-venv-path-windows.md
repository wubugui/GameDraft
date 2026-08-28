现象：`scripts/pytool.cjs` 只在 `.tools/venv/bin/python`（POSIX 布局）里找解释器，Windows 本机 venv 在 `.tools/venv/Scripts/python.exe`，于是一路回落到 PATH 上的 `python3`——而那通常是微软商店的 stub：不报错、不执行、直接退出。`npm run planner:gui` / `npm run filter-tool` 因此在 Windows 上是"跑过了但什么都没发生"。

与库内认知的冲突：这与 `2026-08-17-devsh-posix-venv-path-windows`（dev.sh 同款）、`2026-08-16-python3-store-stub-windows`（stub 静默空转）是**同一个根因的第三处实例**——项目里凡是自己挑 python 的入口都各写了一份候选表，各漏各的。库里没有一条"挑 python 的唯一实现源"。

处置：本次已给 `pytool.cjs` 补上 Scripts 候选与 win32 下回落 `python`（打包管线 `npm run manifest:*` 依赖它）。`scripts/package.mjs` 里也各自写了一份同样的候选表。建议治理 run 考虑把"挑项目 python"收敛成单一实现（`scripts/py.sh` 已是 shell 侧的那一份，Node 侧还没有），否则第四处还会漏。
