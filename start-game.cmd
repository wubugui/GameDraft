@echo off
cd /d "%~dp0"
title GameDraft - Vite
echo 正在启动 GameDraft ^(Vite 开发服，默认 http://localhost:3000^)...
echo 按 Ctrl+C 可停止服务器。
echo.
npm run dev
