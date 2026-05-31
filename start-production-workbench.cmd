@echo off
setlocal
cd /d "%~dp0"
".tools\Python311\python.exe" -m tools.production_workbench "%CD%"
