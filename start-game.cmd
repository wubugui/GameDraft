@echo off
cd /d "%~dp0"
title GameDraft - Vite
if exist ".tools\node-portable\node-v22.14.0-win-x64\npm.cmd" (
  set "PATH=%~dp0.tools\node-portable\node-v22.14.0-win-x64;%PATH%"
)
echo Starting GameDraft Vite dev server at http://localhost:5173 ...
echo Press Ctrl+C to stop.
echo.
npm run dev
