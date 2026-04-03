@echo off
setlocal
echo 正在结束 GameDraft 开发服务器 ^(释放 3000-3003 端口^)...
for %%p in (3000 3001 3002 3003) do (
  for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%%p"') do (
    taskkill /F /PID %%a >nul 2>&1
    if not errorlevel 1 echo 已结束进程 PID %%a ^(端口 %%p^)
  )
)
echo 完成。
REM nopause: skip pause for automation
if /I "%~1"=="nopause" exit /b 0
pause
