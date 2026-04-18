@echo off
cd /d "%~dp0"
python -m tools.chronicle_sim
if errorlevel 1 pause
