@echo off
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0\..\.."
node scripts/pytool.cjs scene_workbench %*
if errorlevel 1 pause
