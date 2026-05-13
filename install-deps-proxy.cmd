@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title GameDraft - npm install (proxy 7078)

set "HTTP_PROXY=http://127.0.0.1:7078"
set "HTTPS_PROXY=http://127.0.0.1:7078"
set "http_proxy=http://127.0.0.1:7078"
set "https_proxy=http://127.0.0.1:7078"
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=localhost,127.0.0.1,::1"

echo 使用临时代理: %HTTP_PROXY%
call npm install
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo npm install 失败 ^(错误码 %ERR%^)。请检查代理是否为 HTTP；SOCKS5 请改脚本内地址为 socks5://127.0.0.1:7078
)
pause
exit /b %ERR%
