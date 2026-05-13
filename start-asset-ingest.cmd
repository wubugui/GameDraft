@echo off
cd /d "%~dp0"
if not exist ".tools\Python311\python.exe" (
  echo Missing local Python runtime. Run init-runtime.cmd first.
  exit /b 1
)
".tools\Python311\python.exe" -m tools.asset_ingest.main
if errorlevel 1 pause
