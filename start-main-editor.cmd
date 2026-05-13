@echo off
cd /d "%~dp0"
title GameDraft - Main Editor
if not exist ".tools\Python311\python.exe" (
  echo Missing local Python runtime. Run init-runtime.cmd first.
  exit /b 1
)
".tools\Python311\python.exe" -m tools.editor "%~dp0."
if errorlevel 1 pause
