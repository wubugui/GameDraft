@echo off
cd /d "%~dp0"
title GameDraft - 主编辑器
python -m tools.editor "%~dp0."
if errorlevel 1 pause
