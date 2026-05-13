@echo off
cd /d "%~dp0"
if not exist ".tools\Python311\python.exe" (
  echo Missing local Python runtime. Run init-runtime.cmd first.
  exit /b 1
)
".tools\Python311\python.exe" -m tools.dialogue_graph_editor --project "%~dp0."
if errorlevel 1 pause
