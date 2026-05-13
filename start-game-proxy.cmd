@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title GameDraft - Vite (proxy 7078)

REM 仅本进程与子进程生效的临时代理（npm / Node 请求 registry 与 Vite 偶发拉取）
set "HTTP_PROXY=http://127.0.0.1:7078"
set "HTTPS_PROXY=http://127.0.0.1:7078"
set "http_proxy=http://127.0.0.1:7078"
set "https_proxy=http://127.0.0.1:7078"
REM 本地开发服不走代理，避免 HMR / 浏览器环回误走代理
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=localhost,127.0.0.1,::1"

if not exist "node_modules\" (
  echo 未检测到 node_modules，正在通过代理安装依赖...
  call npm install
  if errorlevel 1 (
    echo npm install 失败，请确认本机 127.0.0.1:7078 代理已开启，且为 HTTP 代理端口。
    echo 若为 SOCKS5，请编辑本脚本，将上述地址改为 socks5://127.0.0.1:7078
    pause
    exit /b 1
  )
  echo.
)

echo 临时代理: %HTTP_PROXY%
echo 正在启动 GameDraft ^(Vite 开发服，默认 http://localhost:5173^)...
echo 按 Ctrl+C 可停止服务器。
echo.
call npm run dev
endlocal
