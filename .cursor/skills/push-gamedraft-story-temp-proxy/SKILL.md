---
name: push-gamedraft-story-temp-proxy
description: Pushes the GameDraft and Story Git repositories using a one-off HTTP/HTTPS proxy at a user-supplied local port without editing any Git config files. Use when the user asks to push GameDraft 与 Story、两个仓库临时代理推送、用户提供代理端口 push、或不改配置 push 这两个仓库。
---

# GameDraft 与 Story 推送（用户提供代理端口，临时代理，不改配置）

## 用户原话（须遵守）

push GameDraft和Story两个git，使用临时代理端口为7078，不准修改任何配置文件

（**端口约定已迭代**：代理端口**不再写死**；须由用户在当次请求中**明确提供**端口号，未提供则**先索要端口**，再执行推送。其余「仅临时代理、不改任何配置文件」仍完全遵守。）

## 范围与约束

- **两个仓库**：本工作区内独立 Git 仓库
  - GameDraft：`GameDraft/`（默认分支 `master`）
  - Story：`story/`（默认分支 `main`）
- **代理**：仅本次 Git 命令生效；代理 URL 形式为 `http://127.0.0.1:<PORT>`，其中 **`<PORT>` 必须由用户提供**（纯数字，例如用户说「端口 7078」则 `PORT=7078`）。不得擅自假定默认端口。
- **禁止**：编辑或写入任何配置文件，包括但不限于各仓库的 `.git/config`、全局/系统 `gitconfig`、以及为代理目的修改环境变量配置文件。不得使用 `git config` 持久写入代理。

## 执行方式（Windows cmd）

1. **若用户未给出 `<PORT>`：停止推命令，向用户索要「本地 HTTP 代理端口」。**
2. 使用 `git -c` 为**单条命令**注入代理，不触碰磁盘上的 Git 配置。

推送前若需要确认当前分支（可选）：

```cmd
cd /d d:/GameDev/GameDraft && git branch --show-current
cd /d d:/GameDev/story && git branch --show-current
```

推送 GameDraft（将 `<PORT>` 替换为用户提供的端口）：

```cmd
cd /d d:/GameDev/GameDraft && git -c http.proxy=http://127.0.0.1:<PORT> -c https.proxy=http://127.0.0.1:<PORT> push origin master
```

推送 Story：

```cmd
cd /d d:/GameDev/story && git -c http.proxy=http://127.0.0.1:<PORT> -c https.proxy=http://127.0.0.1:<PORT> push origin main
```

若上游分支名与上表不一致，将 `master` / `main` 替换为 `git branch --show-current` 的输出，仍仅用 `-c` 临时代理。

## 失败时

- 代理未开或端口错误：由用户在本机处理；代理技能侧不改为写配置。
- 需凭证：按 Git / GitHub 既有流程处理；仍不修改仓库配置文件来绕过。
