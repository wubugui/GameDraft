---
id: project-interpreter-entrypoint
title: 挑项目 Python 的入口
domain: meta
type: mechanism
summary: 凡"自己挑 Python 解释器"的入口都各写过一份候选表、各漏各的;shell 侧唯一实现源是 scripts/py.sh,Node 侧还没有那一份;挑错的后果是整批静默空转,不报错
status: active
authority:
  - scripts/py.sh
  - scripts/pytool.cjs
triggers:
  paths: ["scripts/py.sh", "scripts/pytool.cjs", "dev.sh", "scripts/package.mjs"]
  topics: [python 解释器, venv, Windows, python3, 入口脚本, 静默失效]
  tasks: [写钩子, 加 CLI 入口, 加打包/工具脚本, 跨平台排障]
last_governed: 2026-09-03
---

## 是什么(一句话)

项目里每个"要跑 Python"的入口(shell 脚本、Node 工具、hook、打包管线)历史上**各自写了
一份解释器候选表**,各漏各的;挑错的表现**不是报错,是什么都没发生**。

## 硬契约

- **"跑项目 Python"的唯一入口是 `scripts/py.sh`**(项目 venv 优先 → `python3` → `python`,
  **失败必出声**)。写新入口、写钩子、写文档里给 agent 的命令,一律走它,不要再手写一份候选表。
  **一个正当例外**:建 venv 的引导脚本本身要在"还没有 venv"时找宿主解释器,它自带一份
  版本下限候选表是应该的——那是**找宿主解释器**,与"跑项目 Python"不是一回事,别把它并进来。
- **Node 侧目前没有那一份**——`scripts/pytool.cjs` 与打包脚本各自维护候选表,是**已知欠账**。
  在 Node 侧新增要跑 Python 的入口时,先看能不能复用现有那一份,别开第三份。
- **任何"挑不到就回落"的逻辑必须出声**:静默回落正是下面这两个坑的放大器。

## 已知坑

- **`python3` 在部分 Windows 机上是应用商店占位程序**:不报错、不执行、直接退出。
  直写 `python3` 的钩子 / CLI / 治理工具因此**整批静默失效而无人察觉**——曾出现治理产物
  停在几周前的状态、所有人都以为在跑。
- **POSIX 布局硬编码**(只找 `venv/bin/python`,不找 `venv/Scripts/python.exe`)会让钦定的
  开发入口在 Windows 上**零启动**:不是慢、不是不稳,是起不来;或者更糟——回落到上面那个
  占位程序,变成"跑过了但什么都没发生"。
- **中文/非 ASCII 输出会在默认控制台编码下抛异常,而那时事情其实已经做完了**:表现是
  一段 traceback,读起来像失败,实际只有那句打印失败。起 Python 子进程时把输出编码显式设成
  UTF-8;看到"报错但结果好像是对的"先怀疑这一条,别去回滚已经成功的动作。
- **停掉一个后台长跑的 Python 任务,停的往往只是外层 shell,Python 子进程会活下来**。
  最坏的形态不是浪费 CPU:两个同类任务并发写同一批产物,而它们各自加载的是**不同时刻的
  模块代码** ⇒ 最终产物是两套代码的混合体,**每一份文件自身都合法**,任何校验器都查不出来。
  停完要**按进程名核一遍真的没了**,再看产物。
- 这是**同一个根因**:每多一个自己挑解释器的入口,就会再犯一次。已实证三处以上同根实例
  (shell 开发入口、Node 工具入口、直写 `python3` 的钩子)。发现某个入口"没反应"时,
  **先验解释器,再查业务逻辑**。

## 怎么验证

```sh
sh scripts/py.sh -c "import sys; print(sys.executable)"
```

这行打出来的就是"这台机器上项目 Python 到底是谁";它若不落在项目 venv 里,
或这行本身没有任何输出,后面所有 Python 入口的结论都不可信。
